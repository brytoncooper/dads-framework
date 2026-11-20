//! Fixture construction shared by the behaviour tests: a throwaway git repository, the manifests
//! written into it, and the assertions that read one decision or one task result back.
use crate::{NativeRequest, Operation, TaskCause};
use serde_json::json;
use std::fs::{create_dir_all, write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
static TEST_REPOSITORY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(super) fn task<'a>(plan: &'a crate::PlanResult, id: &str) -> &'a crate::TaskDecision {
    plan.tasks
        .iter()
        .find(|task| task.id == id)
        .expect("declared task must have a decision")
}

pub(super) fn cited_issues<'a>(
    plan: &'a crate::PlanResult,
    decision: &crate::TaskDecision,
) -> Vec<&'a crate::PlanIssue> {
    decision
        .causes
        .iter()
        .filter_map(|cause| match cause {
            TaskCause::Issue { index } => Some(
                plan.issues
                    .get(*index)
                    .expect("an issue cause must index an emitted issue"),
            ),
            _ => None,
        })
        .collect()
}

pub(super) fn assert_decision(plan: &crate::PlanResult, id: &str, expected: &str) {
    let task = plan
        .tasks
        .iter()
        .find(|task| task.id == id)
        .expect("declared task must have a decision");
    assert_eq!(task.decision, expected);
}

pub(super) fn request(repository: &Path, task_ids: Vec<String>) -> NativeRequest {
    NativeRequest {
        schema_version: 1,
        operation: Operation::Plan,
        workspace_root: repository.display().to_string(),
        manifest_path: None,
        base: None,
        head: None,
        all: false,
        task_ids,
        jobs: None,
    }
}

pub(super) fn run_request(repository: &Path, jobs: Option<u32>) -> NativeRequest {
    NativeRequest {
        schema_version: 1,
        operation: Operation::Run,
        workspace_root: repository.display().to_string(),
        manifest_path: None,
        base: None,
        head: None,
        all: true,
        task_ids: Vec::new(),
        jobs,
    }
}

pub(super) fn write_run_manifest(repository: &Path, tasks: Vec<serde_json::Value>) {
    let task_ids = tasks
        .iter()
        .filter_map(|task| task.get("id"))
        .cloned()
        .collect::<Vec<_>>();
    write_manifest(
        repository,
        json!({
            "schemaVersion": 1,
            "workspace": { "root": ".", "fullFallback": { "taskIds": task_ids } },
            "projects": [{ "id": "fixture", "root": "src", "fallbackDependencies": [] }],
            "tasks": tasks,
        })
        .to_string(),
    );
}

pub(super) fn run_task(id: &str, depends_on: &[&str], script: &str) -> serde_json::Value {
    json!({
        "id": id,
        "project": "fixture",
        "kind": "custom",
        "execution": { "executable": "sh", "args": ["-c", script] },
        "dependsOn": depends_on,
        "impact": { "mode": "always" },
    })
}

pub(super) fn assert_run_status(run: &crate::RunResult, id: &str, expected: &str) {
    let task = run
        .tasks
        .iter()
        .find(|task| task.id == id)
        .expect("task result must be present");
    assert_eq!(task.status, expected);
}

pub(super) fn shell_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\\"'\\\"'"))
}

pub(super) fn testing_repository() -> PathBuf {
    let sequence = TEST_REPOSITORY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let repository = std::env::temp_dir().join(format!(
        "dads-testing-core-{}-{sequence}",
        std::process::id()
    ));
    create_dir_all(repository.join("src")).expect("source directory must be created");
    write(
        repository.join("src/initial.ts"),
        "export const initial = true;\n",
    )
    .expect("initial file must be writable");
    git(&repository, &["init"]);
    git(
        &repository,
        &["config", "user.email", "testing@example.com"],
    );
    git(&repository, &["config", "user.name", "Dads Testing"]);
    git(&repository, &["add", "."]);
    git(&repository, &["commit", "-m", "initial"]);
    repository
}

pub(super) fn write_manifest(repository: &Path, manifest: String) {
    write(repository.join("dads.testing.json"), manifest)
        .expect("testing manifest must be writable");
    git(repository, &["add", "dads.testing.json"]);
    git(repository, &["commit", "-m", "declare tasks"]);
}

pub(super) fn git(repository: &Path, arguments: &[&str]) {
    let status = Command::new("git")
        .args(arguments)
        .current_dir(repository)
        .status()
        .expect("git must start");
    assert!(status.success(), "git {} must succeed", arguments.join(" "));
}

pub(super) fn manifest_with_three_tasks() -> String {
    r#"{
  "schemaVersion": 1,
  "workspace": { "root": ".", "fullFallback": { "taskIds": ["fixture:prepare", "fixture:chosen", "fixture:always"] } },
  "projects": [{ "id": "fixture", "root": "src", "fallbackDependencies": [] }],
  "tasks": [
    { "id": "fixture:prepare", "project": "fixture", "kind": "lint", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "project" } },
    { "id": "fixture:chosen", "project": "fixture", "kind": "test", "execution": { "executable": "true" }, "dependsOn": ["fixture:prepare"], "impact": { "mode": "reachability" } },
    { "id": "fixture:always", "project": "fixture", "kind": "custom", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "always" } }
  ]
}"#.to_owned()
}
