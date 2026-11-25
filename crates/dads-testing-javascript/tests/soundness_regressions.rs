use dads_testing_core::{NativeRequest, Operation, execute_request_with_graph};
use dads_testing_javascript::{JavaScriptFrontend, analyze_request};
use dads_testing_store::{SnapshotAction, load_or_update};
use std::collections::BTreeSet;
use std::error::Error;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_repo(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let id = COUNTER.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "dads-js-soundness-reg-{name}-{}-{id}",
        std::process::id()
    ));
    let _ = remove_dir_all(&root);
    create_dir_all(&root)?;
    Ok(root)
}

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

fn git_init_commit(root: &Path) -> Result<(), Box<dyn Error>> {
    run_git(root, &["init", "-q"])?;
    run_git(root, &["add", "."])?;
    run_git(
        root,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "initial",
        ],
    )
}

fn make_request(root: &Path) -> NativeRequest {
    NativeRequest {
        schema_version: 1,
        operation: Operation::Plan,
        workspace_root: root.display().to_string(),
        manifest_path: Some("dads.testing.json".to_owned()),
        ..NativeRequest::default()
    }
}

#[test]
fn incremental_patch_preserves_outgoing_import_edges_across_cycles_and_edits()
-> Result<(), Box<dyn Error>> {
    let root = temp_repo("inc-edges")?;
    create_dir_all(root.join("lang"))?;
    create_dir_all(root.join("adv"))?;
    write(
        root.join("dads.testing.json"),
        r#"{
  "schemaVersion": 1,
  "workspace": { "fullFallback": { "taskIds": ["lang:test", "adv:test"] } },
  "projects": [
    { "id": "lang", "root": "lang", "fallbackDependencies": [] },
    { "id": "adv", "root": "adv", "fallbackDependencies": [] }
  ],
  "tasks": [
    { "id": "lang:test", "project": "lang", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability", "paths": [] } },
    { "id": "adv:test", "project": "adv", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability", "paths": [] } }
  ]
}"#,
    )?;
    write(
        root.join("lang/cycle-a.ts"),
        "import { cycleB } from \"./cycle-b.ts\";\nexport const cycleBase = 2;\nexport const cycleA = (n: number): number => cycleB(n);\n",
    )?;
    write(
        root.join("lang/cycle-b.ts"),
        "import { cycleBase } from \"./cycle-a.ts\";\nexport const cycleB = (n: number): number => n * cycleBase;\n",
    )?;
    write(root.join("lang/leaf.ts"), "export const leafVal = 1;\n")?;
    write(
        root.join("adv/cycle.test.ts"),
        "import { cycleA } from \"../lang/cycle-a.ts\";\nif (cycleA(3) !== 6) throw new Error(\"bad\");\n",
    )?;
    write(
        root.join("adv/leaf.test.ts"),
        "import { leafVal } from \"../lang/leaf.ts\";\nif (leafVal !== 1) throw new Error(\"bad\");\n",
    )?;
    git_init_commit(&root)?;

    let req = make_request(&root);
    let mut frontend = JavaScriptFrontend;
    let initial = load_or_update(&req, &mut frontend);
    assert_eq!(initial.action, SnapshotAction::InitialIndex);

    // 1. Mutate lang/cycle-a.ts incrementally; outgoing edge cycle-a -> cycle-b must survive
    //    so cycleBase -> cycleB -> cycleA reaches adv/cycle.test.ts.
    write(
        root.join("lang/cycle-a.ts"),
        "import { cycleB } from \"./cycle-b.ts\";\nexport const cycleBase = 9;\nexport const cycleA = (n: number): number => cycleB(n);\n",
    )?;
    let cycle_patch = load_or_update(&req, &mut frontend);
    assert_eq!(cycle_patch.action, SnapshotAction::IncrementalUpdate);
    let patched_graph = cycle_patch.graph.ok_or("patched cycle graph missing")?;
    let cold_graph = analyze_request(&req).ok_or("cold cycle graph missing")?;
    let patched_reach = patched_graph.symbol_reachability_runtime(["lang/cycle-a.ts".to_owned()]);
    let cold_reach = cold_graph.symbol_reachability_runtime(["lang/cycle-a.ts".to_owned()]);
    assert!(
        patched_reach.paths.contains("adv/cycle.test.ts"),
        "incremental cycle patch must reach adv/cycle.test.ts: {:?}",
        patched_reach.paths
    );
    assert_eq!(patched_reach.paths, cold_reach.paths);

    // 2. Patch adv/leaf.test.ts first, then edit lang/leaf.ts; adv/leaf.test.ts -> lang/leaf.ts
    //    must still exist in the persisted snapshot on the subsequent step.
    write(
        root.join("adv/leaf.test.ts"),
        "// touched\nimport { leafVal } from \"../lang/leaf.ts\";\nif (leafVal !== 1) throw new Error(\"bad\");\n",
    )?;
    let step_a = load_or_update(&req, &mut frontend);
    assert_eq!(step_a.action, SnapshotAction::IncrementalUpdate);

    write(root.join("lang/leaf.ts"), "export const leafVal = 2;\n")?;
    let step_b = load_or_update(&req, &mut frontend);
    assert_eq!(step_b.action, SnapshotAction::IncrementalUpdate);
    let leaf_graph = step_b.graph.ok_or("patched leaf graph missing")?;
    let leaf_reach = leaf_graph.symbol_reachability_runtime(["lang/leaf.ts".to_owned()]);
    assert!(
        leaf_reach.paths.contains("adv/leaf.test.ts"),
        "subsequent edit to lang/leaf.ts must still reach previously patched adv/leaf.test.ts: {:?}",
        leaf_reach.paths
    );

    remove_dir_all(root)?;
    Ok(())
}

#[test]
fn default_export_and_ts_enum_edits_select_importers_without_dropping_graph()
-> Result<(), Box<dyn Error>> {
    let root = temp_repo("default-enum")?;
    create_dir_all(root.join("lib"))?;
    create_dir_all(root.join("app"))?;
    create_dir_all(root.join("unrelated"))?;
    write(
        root.join("dads.testing.json"),
        r#"{
  "schemaVersion": 1,
  "workspace": { "fullFallback": { "taskIds": ["lib:test", "app:test", "unrelated:test"] } },
  "projects": [
    { "id": "lib", "root": "lib", "fallbackDependencies": [] },
    { "id": "app", "root": "app", "fallbackDependencies": [] },
    { "id": "unrelated", "root": "unrelated", "fallbackDependencies": [] }
  ],
  "tasks": [
    { "id": "lib:test", "project": "lib", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability", "paths": [] } },
    { "id": "app:test", "project": "app", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability", "paths": [] } },
    { "id": "unrelated:test", "project": "unrelated", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability", "paths": [] } }
  ]
}"#,
    )?;
    write(
        root.join("lib/default-mod.ts"),
        "export default function calc(n: number) { return n * 2; }\n",
    )?;
    write(
        root.join("lib/status-enum.ts"),
        "export enum Status { Ok = 1, Fail = 2 }\n",
    )?;
    write(
        root.join("app/consumer.ts"),
        "import calc from \"../lib/default-mod.ts\";\nimport { Status } from \"../lib/status-enum.ts\";\nexport const out = () => calc(Status.Ok);\n",
    )?;
    write(
        root.join("unrelated/index.ts"),
        "export const unrelated = 1;\n",
    )?;
    git_init_commit(&root)?;

    // 1. Mutate TS enum: graph stays intact, Status is attributed, app:test selected, unrelated:test skipped.
    write(
        root.join("lib/status-enum.ts"),
        "export enum Status { Ok = 9, Fail = 2 }\n",
    )?;
    let req = make_request(&root);
    let enum_graph = analyze_request(&req).ok_or("enum edit must not abort graph analysis")?;
    assert_eq!(
        enum_graph.changed_exports("lib/status-enum.ts"),
        Some(BTreeSet::from(["Status".to_owned()]))
    );
    let enum_resp = execute_request_with_graph(make_request(&root), Some(enum_graph));
    assert!(enum_resp.ok, "{enum_resp:?}");
    let enum_plan = enum_resp.result.ok_or("missing enum plan")?.plan;
    let enum_selected = enum_plan
        .tasks
        .iter()
        .filter(|task| task.decision == "run")
        .map(|task| task.id.as_str())
        .collect::<BTreeSet<_>>();
    assert_eq!(enum_selected, BTreeSet::from(["app:test", "lib:test"]));
    assert!(!enum_plan.scope.full_fallback);

    // 2. Restore enum and mutate default export: graph stays intact and app:test is selected.
    write(
        root.join("lib/status-enum.ts"),
        "export enum Status { Ok = 1, Fail = 2 }\n",
    )?;
    write(
        root.join("lib/default-mod.ts"),
        "export default function calc(n: number) { return n * 9; }\n",
    )?;
    let default_graph =
        analyze_request(&req).ok_or("default export edit must not abort graph analysis")?;
    let default_resp = execute_request_with_graph(req, Some(default_graph));
    assert!(default_resp.ok, "{default_resp:?}");
    let default_plan = default_resp.result.ok_or("missing default plan")?.plan;
    let default_selected = default_plan
        .tasks
        .iter()
        .filter(|task| task.decision == "run")
        .map(|task| task.id.as_str())
        .collect::<BTreeSet<_>>();
    assert!(
        default_selected.contains("app:test") && default_selected.contains("lib:test"),
        "default export mutation must select app:test and lib:test: {default_selected:?}"
    );
    assert!(!default_plan.scope.full_fallback);

    remove_dir_all(root)?;
    Ok(())
}
