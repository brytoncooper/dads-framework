use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, TaskDecision, execute_request_with_graph,
};
use dads_testing_javascript::analyze_request;
use std::error::Error;
use std::fs::{create_dir_all, remove_dir_all, write};
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

fn seed_compiled_dist_monorepo(root: &Path) -> Result<(), Box<dyn Error>> {
    for dir in [
        "packages/provider-utils/src",
        "packages/ai/src",
        "packages/unrelated/src",
    ] {
        create_dir_all(root.join(dir))?;
    }
    write(
        root.join("packages/provider-utils/package.json"),
        r#"{
  "name": "@ai-sdk/provider-utils",
  "exports": { ".": { "import": "./dist/index.js" } }
}"#,
    )?;
    write(
        root.join("packages/provider-utils/src/index.ts"),
        "export function parseEvent(raw: string): number { return raw.length; }\n",
    )?;
    write(
        root.join("packages/ai/package.json"),
        r#"{
  "name": "ai",
  "dependencies": { "@ai-sdk/provider-utils": "workspace:*" }
}"#,
    )?;
    write(
        root.join("packages/ai/src/stream.ts"),
        "import { parseEvent } from '@ai-sdk/provider-utils';\nexport const run = () => parseEvent('hi');\n",
    )?;
    write(
        root.join("packages/unrelated/package.json"),
        r#"{ "name": "unrelated" }"#,
    )?;
    write(
        root.join("packages/unrelated/src/index.ts"),
        "import { something } from '@unknown/other';\nexport const x = something;\n",
    )?;
    write(
        root.join("dads.testing.json"),
        r#"{
  "schemaVersion": 1,
  "workspace": {
    "root": ".",
    "fullFallback": { "taskIds": ["provider-utils:test", "ai:test", "unrelated:test"] }
  },
  "projects": [
    { "id": "provider-utils", "root": "packages/provider-utils", "fallbackDependencies": [] },
    { "id": "ai", "root": "packages/ai", "fallbackDependencies": ["provider-utils"] },
    { "id": "unrelated", "root": "packages/unrelated", "fallbackDependencies": [] }
  ],
  "tasks": [
    {
      "id": "provider-utils:test",
      "project": "provider-utils",
      "kind": "test",
      "execution": { "executable": "node", "args": ["-e", "process.exit(0)"] },
      "dependsOn": [],
      "impact": { "mode": "reachability", "paths": [] }
    },
    {
      "id": "ai:test",
      "project": "ai",
      "kind": "test",
      "execution": { "executable": "node", "args": ["-e", "process.exit(0)"] },
      "dependsOn": [],
      "impact": { "mode": "reachability", "paths": [] }
    },
    {
      "id": "unrelated:test",
      "project": "unrelated",
      "kind": "test",
      "execution": { "executable": "node", "args": ["-e", "process.exit(0)"] },
      "dependsOn": [],
      "impact": { "mode": "reachability", "paths": [] }
    }
  ]
}"#,
    )?;
    git(root, &["add", "."])?;
    git(root, &["commit", "-q", "-m", "initial"])?;
    Ok(())
}

#[test]
fn compiled_dist_workspace_edit_widens_unresolved_fallback_dependents_without_widening_unrelated()
-> Result<(), Box<dyn Error>> {
    let root = fresh_repo("compiled-dist-widening")?;
    seed_compiled_dist_monorepo(&root)?;

    // 1. Semantic edit in upstream compiled-dist package must widen downstream fallback dependent
    //    `ai` (which carries an unresolved bare import for `@ai-sdk/provider-utils`), while
    //    leaving `unrelated` skipped.
    write(
        root.join("packages/provider-utils/src/index.ts"),
        "export function parseEvent(raw: string): number { return raw.length + 1; }\n",
    )?;
    let req = plan_request(&root);
    let graph = analyze_request(&req);
    let resp = execute_request_with_graph(req, graph);
    let plan = resp
        .result
        .ok_or("expected plan result for semantic edit")?
        .plan;

    assert_eq!(find_task(&plan.tasks, "provider-utils:test")?.decision, "run");
    assert_eq!(find_task(&plan.tasks, "ai:test")?.decision, "run");
    assert_eq!(
        find_task(&plan.tasks, "unrelated:test")?.decision,
        "skip-proven-unaffected"
    );

    // 2. Pure comment-only edit in upstream package must still skip everything.
    write(
        root.join("packages/provider-utils/src/index.ts"),
        "// comment only\nexport function parseEvent(raw: string): number { return raw.length; }\n",
    )?;
    let req2 = plan_request(&root);
    let graph2 = analyze_request(&req2);
    let resp2 = execute_request_with_graph(req2, graph2);
    let plan2 = resp2
        .result
        .ok_or("expected plan result for comment edit")?
        .plan;

    assert_eq!(
        find_task(&plan2.tasks, "provider-utils:test")?.decision,
        "skip-proven-unaffected"
    );
    assert_eq!(
        find_task(&plan2.tasks, "ai:test")?.decision,
        "skip-proven-unaffected"
    );
    assert_eq!(
        find_task(&plan2.tasks, "unrelated:test")?.decision,
        "skip-proven-unaffected"
    );

    let _ = remove_dir_all(&root);
    Ok(())
}
