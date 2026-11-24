use dads_testing_core::{NativeRequest, Operation};
use dads_testing_javascript::{JavaScriptFrontend, analyze_request};
use dads_testing_store::{SnapshotAction, load_or_update};
use std::error::Error;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::Path;
use std::process::Command;

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
    }
}

#[test]
fn incremental_patch_preserves_and_updates_file_uncertainties_matching_cold_index()
-> Result<(), Box<dyn Error>> {
    let root = std::env::temp_dir().join("dads-testing-javascript-inc-uncertainty-patch");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src"))?;
    write(
        root.join("dads.testing.json"),
        r#"{
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
"#,
    )?;
    write(
        root.join("src/dynamic.ts"),
        "export async function load(name: string) { return import(name); }\n",
    )?;
    write(
        root.join("src/leaf.ts"),
        "export function add(a: number, b: number) { return a + b; }\n",
    )?;

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

    let req = make_request(&root);
    let mut frontend = JavaScriptFrontend;

    // 1. Initial index records the nonliteral-dynamic-import uncertainty on src/dynamic.ts.
    let initial = load_or_update(&req, &mut frontend);
    assert_eq!(initial.action, SnapshotAction::InitialIndex);
    let initial_graph = initial.graph.ok_or("initial graph missing")?;
    assert_eq!(initial_graph.uncertainties().len(), 1);
    assert_eq!(initial_graph.uncertainties()[0].path, "src/dynamic.ts");

    // 2. Editing src/leaf.ts patches incrementally AND preserves src/dynamic.ts's uncertainty.
    write(
        root.join("src/leaf.ts"),
        "export function add(a: number, b: number) { return a + b + 1; }\n",
    )?;
    let patched = load_or_update(&req, &mut frontend);
    assert_eq!(patched.action, SnapshotAction::IncrementalUpdate);
    let patched_graph = patched.graph.ok_or("patched graph missing")?;
    let cold_graph = analyze_request(&req).ok_or("cold graph missing")?;
    assert_eq!(patched_graph.uncertainties(), cold_graph.uncertainties());
    assert_eq!(
        patched_graph.changed_module_evidences(),
        cold_graph.changed_module_evidences()
    );

    // 3. Removing the dynamic import in src/dynamic.ts clears its uncertainty incrementally.
    write(
        root.join("src/dynamic.ts"),
        "export function load(name: string) { return name; }\n",
    )?;
    let cleared = load_or_update(&req, &mut frontend);
    assert_eq!(cleared.action, SnapshotAction::IncrementalUpdate);
    let cleared_graph = cleared.graph.ok_or("cleared graph missing")?;
    let cold_cleared = analyze_request(&req).ok_or("cold cleared graph missing")?;
    assert!(cleared_graph.uncertainties().is_empty());
    assert_eq!(cleared_graph.uncertainties(), cold_cleared.uncertainties());

    // 4. Introducing a dynamic import in src/leaf.ts records the new uncertainty incrementally.
    write(
        root.join("src/leaf.ts"),
        "export async function add(p: string) { return import(p); }\n",
    )?;
    let added = load_or_update(&req, &mut frontend);
    assert_eq!(added.action, SnapshotAction::IncrementalUpdate);
    let added_graph = added.graph.ok_or("added graph missing")?;
    let cold_added = analyze_request(&req).ok_or("cold added graph missing")?;
    assert_eq!(added_graph.uncertainties().len(), 1);
    assert_eq!(added_graph.uncertainties()[0].path, "src/leaf.ts");
    assert_eq!(added_graph.uncertainties(), cold_added.uncertainties());

    remove_dir_all(root)?;
    Ok(())
}
