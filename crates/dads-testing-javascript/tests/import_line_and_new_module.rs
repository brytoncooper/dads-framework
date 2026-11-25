//! Integration tests matching `proofs/dad-test/DadTest/NamespaceAndImports.lean` (Part B):
//! - Bound import-line edits in pure modules attribute only to exports referencing those bindings
//! - Bare side-effect import edits widen conservatively (`side_effect_import_widens`)
//! - Newly-added pure modules attribute cleanly (`new_pure_module_sound`)
//! - Newly-added impure modules widen conservatively (`new_impure_module_widens`)

use dads_testing_core::{NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION};
use dads_testing_javascript::analyze_request;
use std::collections::BTreeSet;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> Result<(), Box<dyn Error>> {
    let status = Command::new("git").args(args).current_dir(dir).status()?;
    assert!(status.success(), "git {args:?} failed");
    Ok(())
}

fn make_workspace(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let dir =
        std::env::temp_dir().join(format!("dads-js-import-line-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("src"))?;
    git(&dir, &["init", "-q"])?;
    let manifest = r#"{
  "schemaVersion": 1,
  "workspace": { "root": ".", "fullFallback": { "taskIds": ["app:test"] } },
  "projects": [{ "id": "app", "root": "src", "fallbackDependencies": [] }],
  "tasks": [{
    "id": "app:test",
    "project": "app",
    "kind": "test",
    "execution": { "executable": "true" },
    "dependsOn": [],
    "impact": { "mode": "reachability", "paths": [] }
  }]
}
"#;
    fs::write(dir.join("dads.testing.json"), manifest)?;
    fs::write(dir.join("src/dep-a.ts"), "export const aVal = 1;\n")?;
    fs::write(
        dir.join("src/dep-b.ts"),
        "export const bVal = 2;\nexport const bValAlt = 22;\n",
    )?;
    fs::write(dir.join("src/dep-b2.ts"), "export const bVal = 20;\n")?;
    fs::write(dir.join("src/polyfill.ts"), "export const ok = true;\n")?;
    fs::write(
        dir.join("src/service.ts"),
        "import { aVal } from './dep-a';\nimport { bVal } from './dep-b';\nexport function useA() { return aVal; }\nexport function useB() { return bVal; }\n",
    )?;
    fs::write(
        dir.join("src/a.test.ts"),
        "import { useA } from './service';\nexport const runA = () => useA();\n",
    )?;
    fs::write(
        dir.join("src/b.test.ts"),
        "import { useB } from './service';\nexport const runB = () => useB();\n",
    )?;
    git(&dir, &["add", "."])?;
    git(
        &dir,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@e.invalid",
            "commit",
            "-qm",
            "base",
        ],
    )?;
    Ok(dir)
}

fn request(dir: &Path) -> NativeRequest {
    NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Plan,
        workspace_root: dir.display().to_string(),
        manifest_path: None,
        base: None,
        head: None,
        all: false,
        task_ids: Vec::new(),
        task_kinds: Vec::new(),
        shard: None,
        jobs: None,
        cache: false,
        remote_cache_url: None,
        ..NativeRequest::default()
    }
}

#[test]
fn bound_import_line_edit_narrows_to_referencing_export_and_bare_import_widens()
-> Result<(), Box<dyn Error>> {
    let dir = make_workspace("bound-vs-bare")?;

    // 1. Edit ONLY a used named specifier on the SAME module specifier (`./dep-b`):
    //    module load graph is unchanged, so MUST narrow to `useB` and skip `src/a.test.ts`!
    fs::write(
        dir.join("src/service.ts"),
        "import { aVal } from './dep-a';\nimport { bValAlt as bVal } from './dep-b';\nexport function useA() { return aVal; }\nexport function useB() { return bVal; }\n",
    )?;
    let g1 = analyze_request(&request(&dir)).ok_or("missing graph")?;
    assert!(!g1.module_eval_changed("src/service.ts"));
    assert_eq!(
        g1.changed_exports("src/service.ts"),
        Some(BTreeSet::from(["useB".to_owned()]))
    );
    let r1 = g1.symbol_reachability_runtime(vec!["src/service.ts".to_owned()]);
    assert!(r1.uncertainties.is_empty(), "{:?}", r1.uncertainties);
    assert!(r1.paths.contains("src/b.test.ts"));
    assert!(!r1.paths.contains("src/a.test.ts"));

    // 2. Changing the runtime module specifier (`'./dep-b'` -> `'./dep-b2'`) changes which module
    //    evaluates at load time -> `module_eval_changed = true` reaches BOTH runtime importers!
    fs::write(
        dir.join("src/service.ts"),
        "import { aVal } from './dep-a';\nimport { bVal } from './dep-b2';\nexport function useA() { return aVal; }\nexport function useB() { return bVal; }\n",
    )?;
    let g_spec = analyze_request(&request(&dir)).ok_or("missing graph")?;
    assert!(g_spec.module_eval_changed("src/service.ts"));
    let r_spec = g_spec.symbol_reachability_runtime(vec!["src/service.ts".to_owned()]);
    assert!(
        r_spec.uncertainties.is_empty(),
        "{:?}",
        r_spec.uncertainties
    );
    assert!(r_spec.paths.contains("src/a.test.ts"));
    assert!(r_spec.paths.contains("src/b.test.ts"));

    // 3. Adding a bare side-effect import (`import './polyfill'`) sets `module_eval_changed = true`
    //    and propagates to every runtime importer!
    fs::write(
        dir.join("src/service.ts"),
        "import './polyfill';\nimport { aVal } from './dep-a';\nimport { bVal } from './dep-b';\nexport function useA() { return aVal; }\nexport function useB() { return bVal; }\n",
    )?;
    let g2 = analyze_request(&request(&dir)).ok_or("missing graph")?;
    assert!(g2.module_eval_changed("src/service.ts"));
    let r2 = g2.symbol_reachability_runtime(vec!["src/service.ts".to_owned()]);
    assert!(r2.uncertainties.is_empty(), "{:?}", r2.uncertainties);
    assert!(r2.paths.contains("src/a.test.ts"));
    assert!(r2.paths.contains("src/b.test.ts"));

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn export_star_as_namespace_narrows_tracked_members_and_catches_escapes()
-> Result<(), Box<dyn Error>> {
    let dir = make_workspace("ns-reexport")?;
    fs::write(
        dir.join("src/math.ts"),
        "export function add(a: number, b: number) { return a + b; }\nexport function mul(a: number, b: number) { return a * b; }\n",
    )?;
    fs::write(dir.join("src/other.ts"), "export const other = 1;\n")?;
    fs::write(
        dir.join("src/barrel.ts"),
        "export * as math from './math';\nexport { other } from './other';\n",
    )?;
    fs::write(
        dir.join("src/uses-add.test.ts"),
        "import { math } from './barrel';\nexport const t = () => math.add(1, 2);\n",
    )?;
    fs::write(
        dir.join("src/uses-mul.test.ts"),
        "import { math } from './barrel';\nexport const t = () => math.mul(2, 3);\n",
    )?;
    fs::write(
        dir.join("src/escapes-math.test.ts"),
        "import { math } from './barrel';\nexport const t = () => Object.keys(math);\n",
    )?;
    fs::write(
        dir.join("src/uses-other.test.ts"),
        "import { other } from './barrel';\nexport const t = () => other;\n",
    )?;
    git(&dir, &["add", "."])?;
    git(
        &dir,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@e.invalid",
            "commit",
            "-qm",
            "add ns reexport",
        ],
    )?;

    // Mutate ONLY `add` in `src/math.ts`:
    fs::write(
        dir.join("src/math.ts"),
        "export function add(a: number, b: number) { return a + b + 1; }\nexport function mul(a: number, b: number) { return a * b; }\n",
    )?;
    let graph = analyze_request(&request(&dir)).ok_or("missing ns graph")?;
    let reached = graph.symbol_reachability_runtime(vec!["src/math.ts".to_owned()]);
    assert!(
        reached.uncertainties.is_empty(),
        "{:?}",
        reached.uncertainties
    );
    assert!(reached.paths.contains("src/uses-add.test.ts"));
    assert!(reached.paths.contains("src/escapes-math.test.ts"));
    assert!(!reached.paths.contains("src/uses-mul.test.ts"));
    assert!(!reached.paths.contains("src/uses-other.test.ts"));

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}
