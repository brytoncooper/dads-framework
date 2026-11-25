use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, execute_request_with_graph,
};
use dads_testing_javascript::analyze_request;
use std::fs::{create_dir_all, remove_dir_all, remove_file, write};
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(root: &Path, args: &[&str]) {
    let out = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .expect("git must execute");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn fresh_repo(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("dads-testing-js-{name}-{}", std::process::id()));
    let _ = remove_dir_all(&root);
    create_dir_all(&root).expect("temp repo root must be created");
    git(&root, &["init", "-q"]);
    git(&root, &["config", "user.email", "test@example.com"]);
    git(&root, &["config", "user.name", "Test"]);
    root
}

fn plan_request(root: &Path) -> NativeRequest {
    NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Plan,
        workspace_root: root.to_string_lossy().into_owned(),
        ..NativeRequest::default()
    }
}

#[test]
fn deleting_cross_project_module_widens_relative_and_alias_consumers_without_fallbacks() {
    let root = fresh_repo("deleted-cross-project-module");
    for dir in ["lib", "app-rel", "app-alias", "unrelated"] {
        create_dir_all(root.join(dir)).expect("project dir must exist");
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
    )
    .expect("tsconfig must be written");
    write(root.join("lib/deleted.ts"), "export const val = 42;\n").expect("lib module");
    write(
        root.join("app-rel/consumer.test.ts"),
        "import { val } from '../lib/deleted.ts';\nif (val !== 42) throw new Error('bad');\n",
    )
    .expect("relative consumer");
    write(
        root.join("app-alias/consumer.test.ts"),
        "import { val } from '@lib/deleted.ts';\nif (val !== 42) throw new Error('bad');\n",
    )
    .expect("alias consumer");
    write(
        root.join("unrelated/clean.test.ts"),
        "export const ok = true;\n",
    )
    .expect("unrelated project");
    write(
        root.join("dads.testing.json"),
        r#"{
  "schemaVersion": 1,
  "workspace": { "fullFallback": { "taskIds": ["lib:test", "app-rel:test", "app-alias:test", "unrelated:test"] } },
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
    )
    .expect("manifest must be written");
    git(&root, &["add", "."]);
    git(&root, &["commit", "-q", "-m", "baseline"]);

    remove_file(root.join("lib/deleted.ts")).expect("delete cross-project module");

    let req = plan_request(&root);
    let graph = analyze_request(&req).expect("graph must build after delete");
    let resp = execute_request_with_graph(req, Some(graph));
    assert!(resp.ok, "{resp:?}");
    let plan = &resp.result.expect("plan result").plan;
    assert!(
        !plan.scope.full_fallback,
        "must not fall back workspace-wide"
    );

    let decision = |id: &str| {
        plan.tasks
            .iter()
            .find(|t| t.id == id)
            .unwrap_or_else(|| panic!("missing task {id}"))
    };
    assert_eq!(decision("app-rel:test").decision, "run");
    assert_eq!(decision("app-rel:typecheck").decision, "run");
    assert_eq!(decision("app-alias:test").decision, "run");
    assert_eq!(decision("app-alias:typecheck").decision, "run");
    assert_eq!(
        decision("unrelated:test").decision,
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

    remove_dir_all(&root).expect("cleanup temp repo");
}
