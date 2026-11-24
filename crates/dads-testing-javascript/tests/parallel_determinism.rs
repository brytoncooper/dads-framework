use dads_testing_core::{NativeRequest, Operation};
use dads_testing_javascript::{JavaScriptFrontend, analyze_request, analyze_workspace};
use dads_testing_store::{SnapshotAction, load_or_update};
use std::error::Error;
use std::fs::{create_dir_all, read, remove_dir_all, remove_file, write};
use std::path::{Path, PathBuf};
use std::process::Command;

const MANIFEST: &str = r#"{
  "schemaVersion": 1,
  "workspace": { "fullFallback": { "taskIds": ["app:test"] } },
  "projects": [{ "id": "app", "root": "src", "fallbackDependencies": [] }],
  "tasks": [{
    "id": "app:test",
    "project": "app",
    "kind": "test",
    "execution": { "executable": "node", "args": ["-e", "0"] },
    "dependsOn": [],
    "impact": { "mode": "reachability", "paths": [] }
  }]
}
"#;

fn run_git(root: &Path, args: &[&str]) -> Result<(), Box<dyn Error>> {
    let output = Command::new("git").args(args).current_dir(root).output()?;
    if !output.status.success() {
        return Err(format!(
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(())
}

fn make_request(root: &Path) -> NativeRequest {
    NativeRequest {
        schema_version: 1,
        operation: Operation::Plan,
        workspace_root: root.display().to_string(),
        manifest_path: Some("dads.testing.json".to_owned()),
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

fn snapshot_file(root: &Path) -> PathBuf {
    root.join(".git/dads-testing/graph-v1.json")
}

fn write_core_layer(root: &Path) -> Result<(), Box<dyn Error>> {
    create_dir_all(root.join("src/types"))?;
    create_dir_all(root.join("src/core"))?;
    write(
        root.join("src/types/models.ts"),
        "export interface User { id: string; role: string; }\n\
         export interface AuditEntry { actor: string; seq: number; }\n\
         export type Config = { strict: boolean; retries: number };\n",
    )?;
    let mut barrel = String::new();
    for idx in 0..12 {
        write(
            root.join(format!("src/core/leaf_{idx:02}.ts")),
            format!(
                "import type {{ User, Config }} from '../types/models';\n\
                 function computeSalt(n: number): number {{ return n * 3 + {idx}; }}\n\
                 function formatTag(u: User): string {{ return `${{u.id}}:${{u.role}}`; }}\n\
                 export function evalLeaf{idx:02}(u: User, cfg: Config): string {{\n\
                   return `${{formatTag(u)}}#${{computeSalt(cfg.retries)}}`;\n\
                 }}\n\
                 export function wrapLeaf{idx:02}(u: User, cfg: Config): string {{\n\
                   return evalLeaf{idx:02}(u, cfg).toUpperCase();\n\
                 }}\n"
            ),
        )?;
        if idx < 6 {
            barrel.push_str(&format!("export * from './leaf_{idx:02}';\n"));
        } else {
            barrel.push_str(&format!(
                "export {{ evalLeaf{idx:02}, wrapLeaf{idx:02} }} from './leaf_{idx:02}';\n"
            ));
        }
    }
    write(root.join("src/core/index.ts"), barrel)?;
    Ok(())
}

fn write_feature_and_dynamic_layers(root: &Path) -> Result<(), Box<dyn Error>> {
    create_dir_all(root.join("src/features"))?;
    create_dir_all(root.join("src/dynamic"))?;
    let mut feature_barrel = String::new();
    for idx in 0..16 {
        let leaf = idx % 12;
        let prev_import = if idx > 0 {
            let prev = idx - 1;
            format!("import {{ runFeat{prev:02} }} from './feat_{prev:02}';\n")
        } else {
            String::new()
        };
        let prev_call = if idx > 0 {
            let prev = idx - 1;
            format!(" + runFeat{prev:02}(u, cfg).length")
        } else {
            String::new()
        };
        write(
            root.join(format!("src/features/feat_{idx:02}.ts")),
            format!(
                "import type {{ AuditEntry, Config, User }} from '../types/models';\n\
                 import {{ evalLeaf{leaf:02}, wrapLeaf{leaf:02} }} from '../core';\n\
                 {prev_import}\
                 function makeEntry(actor: string): AuditEntry {{ return {{ actor, seq: {idx} }}; }}\n\
                 export function runFeat{idx:02}(u: User, cfg: Config): string {{\n\
                   return evalLeaf{leaf:02}(u, cfg) + String(makeEntry(u.id).seq);\n\
                 }}\n\
                 export function auditFeat{idx:02}(u: User, cfg: Config): number {{\n\
                   return wrapLeaf{leaf:02}(u, cfg).length{prev_call};\n\
                 }}\n"
            ),
        )?;
        feature_barrel.push_str(&format!("export * from './feat_{idx:02}';\n"));
    }
    write(root.join("src/features/index.ts"), feature_barrel)?;

    let mut dynamic_barrel = String::new();
    for idx in 0..6 {
        write(
            root.join(format!("src/dynamic/loader_{idx:02}.ts")),
            format!(
                "export async function loadPlugin{idx:02}(specifier: string) {{\n\
                   return import(specifier);\n\
                 }}\n\
                 export async function loadCore{idx:02}() {{\n\
                   return import('../core');\n\
                 }}\n"
            ),
        )?;
        dynamic_barrel.push_str(&format!("export * from './loader_{idx:02}';\n"));
    }
    write(root.join("src/dynamic/index.ts"), dynamic_barrel)?;
    Ok(())
}

fn write_consumer_layer(root: &Path) -> Result<(), Box<dyn Error>> {
    create_dir_all(root.join("src/consumers"))?;
    for idx in 0..10 {
        let feat = idx % 16;
        let dyn_idx = idx % 6;
        write(
            root.join(format!("src/consumers/app_{idx:02}.ts")),
            format!(
                "import type {{ Config, User }} from '../types/models';\n\
                 import {{ runFeat{feat:02}, auditFeat{feat:02} }} from '../features';\n\
                 import {{ loadCore{dyn_idx:02} }} from '../dynamic';\n\
                 function defaultConfig(): Config {{ return {{ strict: true, retries: {idx} }}; }}\n\
                 export function handleApp{idx:02}(u: User): string {{\n\
                   const cfg = defaultConfig();\n\
                   return `${{runFeat{feat:02}(u, cfg)}}:${{auditFeat{feat:02}(u, cfg)}}`;\n\
                 }}\n\
                 export async function bootApp{idx:02}(u: User) {{\n\
                   const core = await loadCore{dyn_idx:02}();\n\
                   return {{ core, summary: handleApp{idx:02}(u) }};\n\
                 }}\n"
            ),
        )?;
    }
    write(
        root.join("src/index.ts"),
        "export * from './core';\n\
         export * from './features';\n\
         export * from './dynamic';\n\
         export * from './consumers/app_00';\n",
    )?;
    Ok(())
}

fn create_synthetic_workspace(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let root = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
    let _ = remove_dir_all(&root);
    create_dir_all(&root)?;
    write(root.join("dads.testing.json"), MANIFEST)?;
    write_core_layer(&root)?;
    write_feature_and_dynamic_layers(&root)?;
    write_consumer_layer(&root)?;

    run_git(&root, &["init", "-q"])?;
    run_git(&root, &["add", "."])?;
    run_git(
        &root,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "initial",
        ],
    )?;
    Ok(root)
}

#[test]
fn parallel_initial_index_produces_byte_identical_graph_json_across_runs()
-> Result<(), Box<dyn Error>> {
    let root = create_synthetic_workspace("dads-js-parallel-initial")?;
    let req = make_request(&root);
    let snap_path = snapshot_file(&root);
    let mut frontend = JavaScriptFrontend;

    let mut baseline_json: Option<Vec<u8>> = None;
    for run in 0..8 {
        if snap_path.exists() {
            remove_file(&snap_path)?;
        }
        let stored = load_or_update(&req, &mut frontend);
        assert_eq!(stored.action, SnapshotAction::InitialIndex);
        let graph = stored.graph.ok_or("missing indexed graph")?;
        assert_eq!(graph.materialize_modules().len(), 49);
        assert_eq!(graph.uncertainties().len(), 6);

        let serialized = read(&snap_path)?;
        match &baseline_json {
            None => baseline_json = Some(serialized),
            Some(expected) => assert_eq!(
                &serialized, expected,
                "serialized DependencyGraph JSON diverged on run {run}"
            ),
        }
    }

    let baseline_facts = analyze_workspace(&root);
    assert_eq!(baseline_facts.modules.len(), 49);
    assert_eq!(baseline_facts.uncertainties.len(), 6);
    for _ in 0..5 {
        assert_eq!(analyze_workspace(&root), baseline_facts);
    }

    remove_dir_all(root)?;
    Ok(())
}

fn mutate_twelve_workspace_files(root: &Path) -> Result<(), Box<dyn Error>> {
    for idx in 0..4 {
        write(
            root.join(format!("src/core/leaf_{idx:02}.ts")),
            format!(
                "import type {{ User, Config }} from '../types/models';\n\
                 function computeSalt(n: number): number {{ return n * 5 + {idx}; }}\n\
                 function formatTag(u: User): string {{ return `${{u.id}}:${{u.role}}`; }}\n\
                 export function evalLeaf{idx:02}(u: User, cfg: Config): string {{\n\
                   return `${{formatTag(u)}}#${{computeSalt(cfg.retries)}}`;\n\
                 }}\n\
                 export function wrapLeaf{idx:02}(u: User, cfg: Config): string {{\n\
                   return evalLeaf{idx:02}(u, cfg).toUpperCase();\n\
                 }}\n"
            ),
        )?;
    }
    for idx in 0..4 {
        let leaf = idx % 12;
        write(
            root.join(format!("src/features/feat_{idx:02}.ts")),
            format!(
                "import type {{ AuditEntry, Config, User }} from '../types/models';\n\
                 import {{ evalLeaf{leaf:02}, wrapLeaf{leaf:02} }} from '../core';\n\
                 function makeEntry(actor: string): AuditEntry {{ return {{ actor, seq: {idx} + 10 }}; }}\n\
                 export function runFeat{idx:02}(u: User, cfg: Config): string {{\n\
                   return evalLeaf{leaf:02}(u, cfg) + String(makeEntry(u.id).seq);\n\
                 }}\n\
                 export function auditFeat{idx:02}(u: User, cfg: Config): number {{\n\
                   return wrapLeaf{leaf:02}(u, cfg).length;\n\
                 }}\n"
            ),
        )?;
    }
    for idx in 0..2 {
        write(
            root.join(format!("src/dynamic/loader_{idx:02}.ts")),
            format!(
                "export async function loadPlugin{idx:02}(specifier: string) {{\n\
                   return specifier;\n\
                 }}\n\
                 export async function loadCore{idx:02}() {{\n\
                   return import('../core');\n\
                 }}\n"
            ),
        )?;
    }
    for idx in 0..2 {
        write(
            root.join(format!("src/consumers/app_{idx:02}.ts")),
            format!(
                "import type {{ Config, User }} from '../types/models';\n\
                 import {{ runFeat{idx:02}, auditFeat{idx:02} }} from '../features';\n\
                 import {{ loadCore{idx:02} }} from '../dynamic';\n\
                 function defaultConfig(): Config {{ return {{ strict: false, retries: {idx} + 2 }}; }}\n\
                 export function handleApp{idx:02}(u: User): string {{\n\
                   const cfg = defaultConfig();\n\
                   return `${{runFeat{idx:02}(u, cfg)}}:${{auditFeat{idx:02}(u, cfg)}}`;\n\
                 }}\n\
                 export async function bootApp{idx:02}(u: User) {{\n\
                   const core = await loadCore{idx:02}();\n\
                   return {{ core, summary: handleApp{idx:02}(u) }};\n\
                 }}\n"
            ),
        )?;
    }
    Ok(())
}

#[test]
fn parallel_incremental_update_is_byte_identical_and_matches_cold_index()
-> Result<(), Box<dyn Error>> {
    let root = create_synthetic_workspace("dads-js-parallel-incremental")?;
    let req = make_request(&root);
    let snap_path = snapshot_file(&root);
    let mut frontend = JavaScriptFrontend;

    let initial = load_or_update(&req, &mut frontend);
    assert_eq!(initial.action, SnapshotAction::InitialIndex);
    let initial_snapshot_bytes = read(&snap_path)?;

    mutate_twelve_workspace_files(&root)?;

    let mut incremental_json: Option<Vec<u8>> = None;
    let mut last_patched = None;
    for run in 0..6 {
        write(&snap_path, &initial_snapshot_bytes)?;
        let updated = load_or_update(&req, &mut frontend);
        assert_eq!(updated.action, SnapshotAction::IncrementalUpdate);
        let serialized = read(&snap_path)?;
        match &incremental_json {
            None => incremental_json = Some(serialized),
            Some(expected) => assert_eq!(
                &serialized, expected,
                "incremental DependencyGraph JSON diverged on run {run}"
            ),
        }
        last_patched = updated.graph;
    }

    let patched_graph = last_patched.ok_or("missing incrementally updated graph")?;
    let cold_graph = analyze_request(&req).ok_or("missing cold graph")?;
    assert_eq!(patched_graph.materialize_modules().len(), 49);
    assert_eq!(patched_graph.uncertainties(), cold_graph.uncertainties());
    assert_eq!(
        patched_graph.changed_module_evidences(),
        cold_graph.changed_module_evidences()
    );

    // Also exercise the single-file inline fallback path in `incremental_update`.
    write(&snap_path, &initial_snapshot_bytes)?;
    run_git(&root, &["checkout", "--", "."])?;
    write(
        root.join("src/core/leaf_00.ts"),
        "import type { User, Config } from '../types/models';\n\
         function computeSalt(n: number): number { return n * 7; }\n\
         function formatTag(u: User): string { return `${u.id}:${u.role}`; }\n\
         export function evalLeaf00(u: User, cfg: Config): string {\n\
           return `${formatTag(u)}#${computeSalt(cfg.retries)}`;\n\
         }\n\
         export function wrapLeaf00(u: User, cfg: Config): string {\n\
           return evalLeaf00(u, cfg).toUpperCase();\n\
         }\n",
    )?;
    let single = load_or_update(&req, &mut frontend);
    assert_eq!(single.action, SnapshotAction::IncrementalUpdate);
    let single_graph = single.graph.ok_or("missing single-file patched graph")?;
    let cold_single = analyze_request(&req).ok_or("missing cold single graph")?;
    assert_eq!(single_graph.uncertainties(), cold_single.uncertainties());
    assert_eq!(
        single_graph.changed_module_evidences(),
        cold_single.changed_module_evidences()
    );

    remove_dir_all(root)?;
    Ok(())
}
