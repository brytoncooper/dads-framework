use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, TaskDecision, execute_request_with_graph,
};
use dads_testing_javascript::analyze_request;
use std::error::Error;
use std::fs::{create_dir_all, remove_dir_all, remove_file, write};
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(root: &Path, args: &[&str]) -> Result<(), Box<dyn Error>> {
    let out = Command::new("git").current_dir(root).args(args).output()?;
    if !out.status.success() {
        return Err(format!(
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        )
        .into());
    }
    Ok(())
}

fn fresh_repo(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let root = std::env::temp_dir().join(format!("dads-testing-js-{name}-{}", std::process::id()));
    let _ = remove_dir_all(&root);
    create_dir_all(&root)?;
    git(&root, &["init", "-q"])?;
    git(&root, &["config", "user.email", "test@example.com"])?;
    git(&root, &["config", "user.name", "Test"])?;
    Ok(root)
}

fn plan_request(root: &Path) -> NativeRequest {
    NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Plan,
        workspace_root: root.to_string_lossy().into_owned(),
        ..NativeRequest::default()
    }
}

fn find_task<'a>(tasks: &'a [TaskDecision], id: &str) -> Result<&'a TaskDecision, Box<dyn Error>> {
    tasks
        .iter()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("missing task {id}").into())
}

#[test]
fn deleting_cross_project_module_widens_relative_and_alias_consumers_without_fallbacks()
-> Result<(), Box<dyn Error>> {
    let root = fresh_repo("deleted-cross-project-module")?;
    for dir in ["lib", "app-rel", "app-alias", "unrelated"] {
        create_dir_all(root.join(dir))?;
    }
    write(
        root.join("tsconfig.json"),
        r#"{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@lib/*": ["./lib/*"] }
  }
}
"#,
    )?;
    write(root.join("lib/deleted.ts"), "export const val = 42;\n")?;
    write(
        root.join("app-rel/consumer.test.ts"),
        "import { val } from '../lib/deleted.ts';\nif (val !== 42) throw new Error('bad');\n",
    )?;
    write(
        root.join("app-alias/consumer.test.ts"),
        "import { val } from '@lib/deleted.ts';\nif (val !== 42) throw new Error('bad');\n",
    )?;
    write(
        root.join("unrelated/clean.test.ts"),
        "export const ok = true;\n",
    )?;
    write(
        root.join("dads.testing.json"),
        r#"{
  "schemaVersion": 1,
  "workspace": { "fullFallback": { "taskIds": ["lib:test", "app-rel:test", "app-rel:typecheck", "app-alias:test", "app-alias:typecheck", "unrelated:test"] } },
  "projects": [
    { "id": "lib", "root": "lib", "fallbackDependencies": [] },
    { "id": "app-rel", "root": "app-rel", "fallbackDependencies": [] },
    { "id": "app-alias", "root": "app-alias", "fallbackDependencies": [] },
    { "id": "unrelated", "root": "unrelated", "fallbackDependencies": [] }
  ],
  "tasks": [
    { "id": "lib:test", "project": "lib", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "app-rel:test", "project": "app-rel", "kind": "test", "execution": { "executable": "true", "fileNarrowing": { "suffixes": [".test.ts"], "setupFiles": [] } }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "app-rel:typecheck", "project": "app-rel", "kind": "typecheck", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "app-alias:test", "project": "app-alias", "kind": "test", "execution": { "executable": "true", "fileNarrowing": { "suffixes": [".test.ts"], "setupFiles": [] } }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "app-alias:typecheck", "project": "app-alias", "kind": "typecheck", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "unrelated:test", "project": "unrelated", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } }
  ]
}
"#,
    )?;
    git(&root, &["add", "."])?;
    git(&root, &["commit", "-q", "-m", "baseline"])?;

    remove_file(root.join("lib/deleted.ts"))?;

    let req = plan_request(&root);
    let graph = analyze_request(&req).ok_or("graph must build after delete")?;
    let resp = execute_request_with_graph(req, Some(graph));
    assert!(resp.ok, "{resp:?}");
    let plan = &resp.result.ok_or("plan result")?.plan;
    assert!(
        !plan.scope.full_fallback,
        "must not fall back workspace-wide"
    );

    assert_eq!(find_task(&plan.tasks, "app-rel:test")?.decision, "run");
    assert_eq!(find_task(&plan.tasks, "app-rel:typecheck")?.decision, "run");
    assert_eq!(find_task(&plan.tasks, "app-alias:test")?.decision, "run");
    assert_eq!(
        find_task(&plan.tasks, "app-alias:typecheck")?.decision,
        "run"
    );
    assert_eq!(
        find_task(&plan.tasks, "unrelated:test")?.decision,
        "skip-proven-unaffected",
        "unrelated clean project must remain skipped"
    );
    assert!(
        plan.issues
            .iter()
            .any(|i| i.code == "unresolved-import-after-delete"),
        "must record unresolved-import-after-delete issue: {:?}",
        plan.issues
    );

    remove_dir_all(&root)?;
    Ok(())
}

#[test]
fn fs_read_edge_targeting_isolated_test_file_does_not_widen_downstream_dependents()
-> Result<(), Box<dyn Error>> {
    let root = fresh_repo("fs-edge-isolated-test-file")?;
    for dir in ["lib", "app", "other"] {
        create_dir_all(root.join(dir))?;
    }
    write(root.join("lib/index.ts"), "export const v = 1;\n")?;
    write(
        root.join("lib/parity.test.ts"),
        r#"import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const files = readdirSync(join(__dirname, "../other"));
export const check = (name: string) => readFileSync(join(__dirname, name), "utf8") + files.length;
"#,
    )?;
    write(
        root.join("app/app.test.ts"),
        "import { v } from '../lib/index.ts';\nif (v !== 1) throw new Error('bad');\n",
    )?;
    write(
        root.join("other/scanner.test.ts"),
        r#"import { readdirSync } from "node:fs";
import { join } from "node:path";
export const entries = readdirSync(join(__dirname, "../lib"));
"#,
    )?;
    write(
        root.join("dads.testing.json"),
        r#"{
  "schemaVersion": 1,
  "workspace": { "fullFallback": { "taskIds": ["lib:test", "app:test", "other:test"] } },
  "projects": [
    { "id": "lib", "root": "lib", "fallbackDependencies": [] },
    { "id": "app", "root": "app", "fallbackDependencies": ["lib"] },
    { "id": "other", "root": "other", "fallbackDependencies": [] }
  ],
  "tasks": [
    { "id": "lib:test", "project": "lib", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "app:test", "project": "app", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "other:test", "project": "other", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } }
  ]
}
"#,
    )?;
    git(&root, &["add", "."])?;
    git(&root, &["commit", "-q", "-m", "baseline"])?;

    write(
        root.join("other/scanner.test.ts"),
        r#"import { readdirSync } from "node:fs";
import { join } from "node:path";
export const entries = readdirSync(join(__dirname, "../lib")).slice(0);
"#,
    )?;

    let req = plan_request(&root);
    let graph = analyze_request(&req).ok_or("graph must build")?;
    assert!(
        !graph.has_importers("lib/parity.test.ts"),
        "raw fs: edge from readdirSync must not mark an isolated test file as imported"
    );
    let resp = execute_request_with_graph(req, Some(graph));
    assert!(resp.ok, "{resp:?}");
    let plan = &resp.result.ok_or("plan result")?.plan;
    assert_eq!(find_task(&plan.tasks, "lib:test")?.decision, "run");
    assert_eq!(find_task(&plan.tasks, "other:test")?.decision, "run");
    assert_eq!(
        find_task(&plan.tasks, "app:test")?.decision,
        "skip-proven-unaffected",
        "downstream dependent of lib must not widen because lib/parity.test.ts is an isolated test file"
    );

    remove_dir_all(&root)?;
    Ok(())
}
