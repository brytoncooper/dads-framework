use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, execute_request_with_graph,
};
use dads_testing_javascript::analyze_request;
use std::error::Error;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(root: &Path, args: &[&str]) -> Result<(), Box<dyn Error>> {
    let status = Command::new("git").current_dir(root).args(args).status()?;
    if !status.success() {
        return Err(format!("git {args:?} failed").into());
    }
    Ok(())
}

fn init_fixture(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let root =
        std::env::temp_dir().join(format!("dads-testing-js-092-{name}-{}", std::process::id()));
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("lib"))?;
    create_dir_all(root.join("app"))?;
    write(
        root.join("dads.testing.json"),
        r#"{
  "schemaVersion": 1,
  "workspace": { "fullFallback": { "taskIds": ["lib:typecheck", "app:test", "app:typecheck"] } },
  "projects": [
    { "id": "lib", "root": "lib", "fallbackDependencies": [] },
    { "id": "app", "root": "app", "fallbackDependencies": ["lib"] }
  ],
  "tasks": [
    { "id": "lib:typecheck", "project": "lib", "kind": "typecheck", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "app:test", "project": "app", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "app:typecheck", "project": "app", "kind": "typecheck", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } }
  ]
}"#,
    )?;
    Ok(root)
}

fn commit(root: &Path) -> Result<(), Box<dyn Error>> {
    git(root, &["init", "--quiet"])?;
    git(root, &["config", "user.name", "Test"])?;
    git(root, &["config", "user.email", "test@example.com"])?;
    git(root, &["add", "."])?;
    git(root, &["commit", "--quiet", "-m", "init"])
}

fn plan_for(root: &Path) -> Result<dads_testing_core::PlanResult, Box<dyn Error>> {
    let req = NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Plan,
        workspace_root: root.to_string_lossy().into_owned(),
        ..NativeRequest::default()
    };
    let graph = analyze_request(&req);
    let response = execute_request_with_graph(req, graph);
    response
        .result
        .map(|r| r.plan)
        .ok_or_else(|| format!("plan failed: {:?}", response.error).into())
}

#[test]
fn jsdoc_plus_export_type_attributes_precisely_without_fallback() -> Result<(), Box<dyn Error>> {
    let root = init_fixture("jsdoc-type")?;
    write(
        root.join("lib/index.ts"),
        "export type Kept = string;\nexport function runtimeFn() { return 1; }\n",
    )?;
    write(
        root.join("app/index.ts"),
        "import type { Kept } from '../lib';\nimport '../lib';\nexport type Local = Kept;\n",
    )?;
    commit(&root)?;

    // Adding a JSDoc comment + new export type in the same hunk must NOT widen app!
    write(
        root.join("lib/index.ts"),
        "export type Kept = string;\nexport function runtimeFn() { return 1; }\n/** Added wire type. */\nexport type AddedType = number;\n",
    )?;
    let plan = plan_for(&root)?;
    assert!(
        plan.issues.is_empty(),
        "unexpected issues: {:?}",
        plan.issues
    );
    assert_eq!(
        plan.tasks
            .iter()
            .find(|t| t.id == "app:typecheck")
            .map(|t| t.decision.as_str()),
        Some("skip-proven-unaffected")
    );
    assert_eq!(
        plan.tasks
            .iter()
            .find(|t| t.id == "app:test")
            .map(|t| t.decision.as_str()),
        Some("skip-proven-unaffected")
    );
    remove_dir_all(root)?;
    Ok(())
}

#[test]
fn mixed_runtime_and_type_import_reaches_typecheck_when_type_changes() -> Result<(), Box<dyn Error>>
{
    let root = init_fixture("mixed-import")?;
    write(
        root.join("lib/index.ts"),
        "export type SharedType = { id: string };\nexport function helper() { return 1; }\n",
    )?;
    write(
        root.join("app/index.ts"),
        "import { helper, type SharedType } from '../lib';\nexport function use(x: SharedType) { return helper() + x.id.length; }\n",
    )?;
    commit(&root)?;

    write(
        root.join("lib/index.ts"),
        "/** Updated type. */\nexport type SharedType = { id: number };\nexport function helper() { return 1; }\n",
    )?;
    let plan = plan_for(&root)?;
    assert!(
        plan.issues.is_empty(),
        "unexpected issues: {:?}",
        plan.issues
    );
    assert_eq!(
        plan.tasks
            .iter()
            .find(|t| t.id == "app:typecheck")
            .map(|t| t.decision.as_str()),
        Some("run")
    );
    assert_eq!(
        plan.tasks
            .iter()
            .find(|t| t.id == "app:test")
            .map(|t| t.decision.as_str()),
        Some("skip-proven-unaffected")
    );
    remove_dir_all(root)?;
    Ok(())
}
