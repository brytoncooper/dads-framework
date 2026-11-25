use dads_testing_core::graph::{DependencyGraph, ImportFact, ImportKind, ModuleNode, SourceSpan};
use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, execute_request_with_graph,
};
use serde_json::json;
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

fn make_tsconfig_repo(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let dir = std::env::temp_dir().join(format!(
        "dads-testing-tsconfig-{name}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("packages/alpha/src"))?;
    fs::create_dir_all(dir.join("packages/beta/src"))?;
    fs::create_dir_all(dir.join("packages/gamma/src"))?;
    fs::create_dir_all(dir.join("packages/shared/src"))?;
    git(&dir, &["init", "-q"])?;

    let manifest = json!({
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "fullFallback": { "taskIds": ["alpha:test", "beta:test", "gamma:test", "shared:test"] }
        },
        "projects": [
            { "id": "alpha", "root": "packages/alpha", "fallbackDependencies": [] },
            { "id": "beta", "root": "packages/beta", "fallbackDependencies": [] },
            { "id": "gamma", "root": "packages/gamma", "fallbackDependencies": [] },
            { "id": "shared", "root": "packages/shared", "fallbackDependencies": [] }
        ],
        "tasks": [
            {
                "id": "alpha:test",
                "project": "alpha",
                "kind": "test",
                "execution": { "executable": "true", "args": [] },
                "dependsOn": [],
                "impact": { "mode": "reachability", "paths": ["tsconfig.base.json"] }
            },
            {
                "id": "beta:test",
                "project": "beta",
                "kind": "test",
                "execution": { "executable": "true", "args": [] },
                "dependsOn": [],
                "impact": { "mode": "reachability", "paths": ["tsconfig.base.json"] }
            },
            {
                "id": "gamma:test",
                "project": "gamma",
                "kind": "test",
                "execution": { "executable": "true", "args": [] },
                "dependsOn": [],
                "impact": { "mode": "reachability", "paths": ["tsconfig.base.json"] }
            },
            {
                "id": "shared:test",
                "project": "shared",
                "kind": "test",
                "execution": { "executable": "true", "args": [] },
                "dependsOn": [],
                "impact": { "mode": "reachability", "paths": ["tsconfig.base.json"] }
            }
        ]
    });
    fs::write(
        dir.join("dads.testing.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;

    let tsconfig_base = r#"{
  // Base workspace tsconfig with JSONC comments and trailing commas
  "compilerOptions": {
    "strict": true,
    "baseUrl": ".",
    "paths": {
      "@acme/shared": ["packages/shared/src/index.ts"],
      "@acme/shared/*": ["packages/shared/src/*"],
      "@acme/beta-lib": ["packages/beta/src/lib.ts"],
    },
  },
}
"#;
    fs::write(dir.join("tsconfig.base.json"), tsconfig_base)?;

    fs::write(
        dir.join("packages/shared/src/index.ts"),
        "export const sharedValue = 1;\n",
    )?;
    fs::write(
        dir.join("packages/alpha/src/index.ts"),
        "import { sharedValue } from '@acme/shared'; export const a = sharedValue;\n",
    )?;
    fs::write(
        dir.join("packages/gamma/src/index.ts"),
        "import { a } from '../../alpha/src/index'; export const g = a;\n",
    )?;
    fs::write(
        dir.join("packages/beta/src/index.ts"),
        "import { b } from '@acme/beta-lib'; export const beta = b;\n",
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

fn static_import(specifier: &str, symbol: &str, resolved_path: Option<&str>) -> ImportFact {
    ImportFact {
        specifier: specifier.to_owned(),
        span: SourceSpan { start: 0, end: 10 },
        kind: ImportKind::Static,
        type_only: false,
        requested_symbols: BTreeSet::from([symbol.to_owned()]),
        namespace_import: false,
        reexport_all: false,
        reexport_namespace: None,
        resolved_path: resolved_path.map(str::to_owned),
        position: None,
        export_deps: None,
        member_reads: None,
    }
}

fn fixture_graph(alpha_resolved: Option<&str>) -> DependencyGraph {
    let nodes = vec![
        ModuleNode {
            path: "packages/shared/src/index.ts".to_owned(),
            language: "typescript".to_owned(),
            declarations: Vec::new(),
            references: Vec::new(),
            imports: Vec::new(),
        },
        ModuleNode {
            path: "packages/alpha/src/index.ts".to_owned(),
            language: "typescript".to_owned(),
            declarations: Vec::new(),
            references: Vec::new(),
            imports: vec![static_import("@acme/shared", "sharedValue", alpha_resolved)],
        },
        ModuleNode {
            path: "packages/gamma/src/index.ts".to_owned(),
            language: "typescript".to_owned(),
            declarations: Vec::new(),
            references: Vec::new(),
            imports: vec![static_import(
                "../../alpha/src/index",
                "a",
                Some("packages/alpha/src/index.ts"),
            )],
        },
        ModuleNode {
            path: "packages/beta/src/index.ts".to_owned(),
            language: "typescript".to_owned(),
            declarations: Vec::new(),
            references: Vec::new(),
            imports: vec![static_import("@acme/beta-lib", "b", None)],
        },
    ];
    DependencyGraph::new(nodes, Vec::new())
}

struct PlanOutcome {
    selected: Vec<String>,
    full_fallback: bool,
    issue_codes: Vec<String>,
}

fn run_plan_with_graph(
    dir: &Path,
    base: &str,
    head: Option<&str>,
    graph: DependencyGraph,
) -> Result<PlanOutcome, Box<dyn Error>> {
    let req = NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Plan,
        workspace_root: dir.display().to_string(),
        manifest_path: None,
        base: Some(base.to_owned()),
        head: head.map(str::to_owned),
        all: false,
        task_ids: Vec::new(),
        task_kinds: Vec::new(),
        shard: None,
        jobs: None,
        cache: false,
        remote_cache_url: None,
        ..NativeRequest::default()
    };
    let resp = execute_request_with_graph(req, Some(graph));
    assert!(resp.ok, "{resp:?}");
    let plan = resp.result.ok_or("missing result")?.plan;
    let selected = plan
        .tasks
        .into_iter()
        .filter(|t| t.decision == "run")
        .map(|t| t.id)
        .collect();
    let issue_codes = plan.issues.into_iter().map(|i| i.code).collect();
    Ok(PlanOutcome {
        selected,
        full_fallback: plan.scope.full_fallback,
        issue_codes,
    })
}

#[test]
fn adding_unused_alias_widens_zero_projects() -> Result<(), Box<dyn Error>> {
    let dir = make_tsconfig_repo("unused-alias")?;
    let updated = r#"{
  // Added a brand-new unused alias
  "compilerOptions": {
    "strict": true,
    "baseUrl": ".",
    "paths": {
      "@acme/shared": ["packages/shared/src/index.ts"],
      "@acme/shared/*": ["packages/shared/src/*"],
      "@acme/beta-lib": ["packages/beta/src/lib.ts"],
      "@acme/brand-new": ["packages/brand-new/src/index.ts"],
    },
  },
}
"#;
    fs::write(dir.join("tsconfig.base.json"), updated)?;

    let outcome = run_plan_with_graph(
        &dir,
        "HEAD",
        None,
        fixture_graph(Some("packages/shared/src/index.ts")),
    )?;
    assert!(!outcome.full_fallback);
    assert_eq!(outcome.selected, Vec::<String>::new());
    assert!(
        outcome
            .issue_codes
            .contains(&"tsconfig-paths-narrowed".to_owned())
    );
    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn adding_alias_imported_by_existing_module_selects_only_that_project() -> Result<(), Box<dyn Error>>
{
    let dir = make_tsconfig_repo("added-used-alias")?;
    let updated = r#"{
  "compilerOptions": {
    "strict": true,
    "baseUrl": ".",
    "paths": {
      "@acme/shared": ["packages/shared/src/index.ts"],
      "@acme/shared/*": ["packages/shared/src/*"],
      "@acme/beta-lib": ["packages/beta/src/lib.ts"],
      "@acme/newly-aliased": ["packages/shared/src/index.ts"],
    },
  },
}
"#;
    fs::write(dir.join("tsconfig.base.json"), updated)?;

    let graph = DependencyGraph::new(
        vec![
            ModuleNode {
                path: "packages/alpha/src/index.ts".to_owned(),
                language: "typescript".to_owned(),
                declarations: Vec::new(),
                references: Vec::new(),
                imports: vec![static_import("@acme/shared", "sharedValue", None)],
            },
            ModuleNode {
                path: "packages/beta/src/index.ts".to_owned(),
                language: "typescript".to_owned(),
                declarations: Vec::new(),
                references: Vec::new(),
                imports: vec![static_import(
                    "@acme/newly-aliased",
                    "sharedValue",
                    Some("packages/shared/src/index.ts"),
                )],
            },
        ],
        Vec::new(),
    );

    let outcome = run_plan_with_graph(&dir, "HEAD", None, graph)?;
    assert!(!outcome.full_fallback);
    assert_eq!(outcome.selected, vec!["beta:test".to_owned()]);
    assert!(
        outcome
            .issue_codes
            .contains(&"tsconfig-paths-narrowed".to_owned())
    );
    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn modifying_alias_selects_only_importer_and_reverse_dependents() -> Result<(), Box<dyn Error>> {
    let dir = make_tsconfig_repo("modify-alias")?;
    let updated = r#"{
  "compilerOptions": {
    "strict": true,
    "baseUrl": ".",
    "paths": {
      "@acme/shared": ["packages/shared/src/v2.ts"],
      "@acme/shared/*": ["packages/shared/src/*"],
      "@acme/beta-lib": ["packages/beta/src/lib.ts"],
    },
  },
}
"#;
    fs::write(dir.join("tsconfig.base.json"), updated)?;

    let outcome = run_plan_with_graph(
        &dir,
        "HEAD",
        None,
        fixture_graph(Some("packages/shared/src/index.ts")),
    )?;
    assert!(!outcome.full_fallback);
    assert_eq!(
        outcome.selected,
        vec!["alpha:test".to_owned(), "gamma:test".to_owned()]
    );
    assert!(
        outcome
            .issue_codes
            .contains(&"tsconfig-paths-narrowed".to_owned())
    );
    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn removing_alias_selects_only_importer_and_reverse_dependents() -> Result<(), Box<dyn Error>> {
    let dir = make_tsconfig_repo("remove-alias")?;
    let updated = r#"{
  "compilerOptions": {
    "strict": true,
    "baseUrl": ".",
    "paths": {
      "@acme/shared/*": ["packages/shared/src/*"],
      "@acme/beta-lib": ["packages/beta/src/lib.ts"],
    },
  },
}
"#;
    fs::write(dir.join("tsconfig.base.json"), updated)?;

    // Removed alias no longer resolves in the new graph (`resolved_path: None`).
    let outcome = run_plan_with_graph(&dir, "HEAD", None, fixture_graph(None))?;
    assert!(!outcome.full_fallback);
    assert_eq!(
        outcome.selected,
        vec!["alpha:test".to_owned(), "gamma:test".to_owned()]
    );
    assert!(
        outcome
            .issue_codes
            .contains(&"tsconfig-paths-narrowed".to_owned())
    );
    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn changing_compiler_options_strict_widens_all_tasks() -> Result<(), Box<dyn Error>> {
    let dir = make_tsconfig_repo("strict-widen")?;
    let updated = r#"{
  "compilerOptions": {
    "strict": false,
    "baseUrl": ".",
    "paths": {
      "@acme/shared": ["packages/shared/src/index.ts"],
      "@acme/shared/*": ["packages/shared/src/*"],
      "@acme/beta-lib": ["packages/beta/src/lib.ts"],
    },
  },
}
"#;
    fs::write(dir.join("tsconfig.base.json"), updated)?;

    let outcome = run_plan_with_graph(
        &dir,
        "HEAD",
        None,
        fixture_graph(Some("packages/shared/src/index.ts")),
    )?;
    assert_eq!(
        outcome.selected,
        vec![
            "alpha:test".to_owned(),
            "beta:test".to_owned(),
            "gamma:test".to_owned(),
            "shared:test".to_owned(),
        ]
    );
    assert!(
        outcome
            .issue_codes
            .contains(&"tsconfig-global-change".to_owned())
    );
    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn malformed_json_in_tsconfig_fails_closed_and_widens_all() -> Result<(), Box<dyn Error>> {
    let dir = make_tsconfig_repo("malformed-json")?;
    fs::write(
        dir.join("tsconfig.base.json"),
        "{ \"compilerOptions\": { \"paths\": { /* unterminated comment",
    )?;

    let outcome = run_plan_with_graph(
        &dir,
        "HEAD",
        None,
        fixture_graph(Some("packages/shared/src/index.ts")),
    )?;
    assert_eq!(
        outcome.selected,
        vec![
            "alpha:test".to_owned(),
            "beta:test".to_owned(),
            "gamma:test".to_owned(),
            "shared:test".to_owned(),
        ]
    );
    assert!(
        outcome
            .issue_codes
            .contains(&"tsconfig-parse-fallback".to_owned())
    );
    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn newly_added_tsconfig_without_base_fails_closed_and_widens_all() -> Result<(), Box<dyn Error>> {
    let dir = make_tsconfig_repo("new-tsconfig")?;
    fs::write(
        dir.join("tsconfig.paths.json"),
        r#"{ "compilerOptions": { "paths": { "@acme/new": ["packages/alpha/src/index.ts"] } } }"#,
    )?;

    let outcome = run_plan_with_graph(
        &dir,
        "HEAD",
        None,
        fixture_graph(Some("packages/shared/src/index.ts")),
    )?;
    assert!(outcome.full_fallback);
    assert_eq!(
        outcome.selected,
        vec![
            "alpha:test".to_owned(),
            "beta:test".to_owned(),
            "gamma:test".to_owned(),
            "shared:test".to_owned(),
        ]
    );
    assert!(
        outcome
            .issue_codes
            .contains(&"tsconfig-base-unavailable".to_owned())
    );
    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn commit_to_commit_wildcard_alias_narrowing_works() -> Result<(), Box<dyn Error>> {
    let dir = make_tsconfig_repo("commit-to-commit")?;
    let updated = r#"{
  "compilerOptions": {
    "strict": true,
    "baseUrl": ".",
    "paths": {
      "@acme/shared": ["packages/shared/src/index.ts"],
      "@acme/shared/*": ["packages/shared/src/v2/*"],
      "@acme/beta-lib": ["packages/beta/src/lib.ts"],
    },
  },
}
"#;
    fs::write(dir.join("tsconfig.base.json"), updated)?;
    git(&dir, &["add", "tsconfig.base.json"])?;
    git(
        &dir,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@e.invalid",
            "commit",
            "-qm",
            "update wildcard",
        ],
    )?;

    // Graph where beta imports `@acme/shared/utils` (matches `@acme/shared/*`), alpha imports `@acme/shared` (does NOT match `@acme/shared/*`).
    let graph = DependencyGraph::new(
        vec![
            ModuleNode {
                path: "packages/alpha/src/index.ts".to_owned(),
                language: "typescript".to_owned(),
                declarations: Vec::new(),
                references: Vec::new(),
                imports: vec![static_import(
                    "@acme/shared",
                    "sharedValue",
                    Some("packages/shared/src/index.ts"),
                )],
            },
            ModuleNode {
                path: "packages/beta/src/index.ts".to_owned(),
                language: "typescript".to_owned(),
                declarations: Vec::new(),
                references: Vec::new(),
                imports: vec![static_import("@acme/shared/utils", "u", None)],
            },
        ],
        Vec::new(),
    );

    let outcome = run_plan_with_graph(&dir, "HEAD~1", Some("HEAD"), graph)?;
    assert!(!outcome.full_fallback);
    assert_eq!(outcome.selected, vec!["beta:test".to_owned()]);
    assert!(
        outcome
            .issue_codes
            .contains(&"tsconfig-paths-narrowed".to_owned())
    );
    let _ = fs::remove_dir_all(&dir);
    Ok(())
}
