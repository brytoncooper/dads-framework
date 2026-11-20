//! Plan decisions from changed paths alone: path ownership, the complete fallback, and the
//! emitted wire shape.
use super::support::{
    assert_decision, cited_issues, git, manifest_with_three_tasks, request, task,
    testing_repository, write_manifest,
};
use crate::manifest::Project;
use crate::scope::path_is_inside;
use crate::{TaskCause, execute_request};
use std::fs::{create_dir_all, remove_dir_all, write};
#[test]
fn direct_input_includes_prerequisites_and_always_tasks() {
    let repository = testing_repository();
    write_manifest(&repository, manifest_with_three_tasks());

    let response = execute_request(request(&repository, vec!["fixture:chosen".into()]));
    assert!(response.ok, "{response:?}");
    let plan = &response
        .result
        .expect("successful response must include a plan")
        .plan;
    assert_decision(plan, "fixture:prepare", "run");
    assert_decision(plan, "fixture:chosen", "run");
    assert_decision(plan, "fixture:always", "run");
    let chosen = task(plan, "fixture:chosen");
    let prepare = task(plan, "fixture:prepare");
    assert_eq!(chosen.reason, "direct-task-input");
    assert_eq!(
        chosen.causes,
        vec![TaskCause::DirectTaskInput {
            task_id: "fixture:chosen".to_owned(),
        }]
    );
    assert_eq!(prepare.reason, "selected-prerequisite");
    assert_eq!(
        prepare.causes,
        vec![TaskCause::PrerequisiteOf {
            task_id: "fixture:chosen".to_owned(),
        }]
    );
    assert_eq!(prepare.project, "fixture");
    assert!(task(plan, "fixture:always").causes.is_empty());
    remove_dir_all(repository).expect("temporary repository must be removable");
}

#[test]
fn changed_nested_project_uses_deepest_owner_when_parent_is_listed_first() {
    let repository = testing_repository();
    create_dir_all(repository.join("packages/child"))
        .expect("nested project directory must be created");
    write(
        repository.join("packages/child/changed.ts"),
        "export const changed = true;\n",
    )
    .expect("nested changed file must be writable");
    git(&repository, &["add", "."]);
    git(&repository, &["commit", "-m", "add nested project fixture"]);
    write_manifest(
            &repository,
            r#"{
  "schemaVersion": 1,
  "workspace": { "root": ".", "fullFallback": { "taskIds": ["parent:test", "child:test"] } },
  "projects": [
    { "id": "parent", "root": "packages", "fallbackDependencies": [] },
    { "id": "child", "root": "packages/child", "fallbackDependencies": [] }
  ],
  "tasks": [
    { "id": "parent:test", "project": "parent", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "project" } },
    { "id": "child:test", "project": "child", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "project" } }
  ]
}"#
            .to_owned(),
        );
    write(
        repository.join("packages/child/changed.ts"),
        "export const changed = false;\n",
    )
    .expect("nested project change must be writable");

    let response = execute_request(request(&repository, Vec::new()));
    assert!(response.ok, "{response:?}");
    let plan = &response
        .result
        .expect("successful response must include a plan")
        .plan;
    assert_decision(plan, "parent:test", "skip-proven-unaffected");
    assert_decision(plan, "child:test", "run");
    remove_dir_all(repository).expect("temporary repository must be removable");
}

#[test]
fn changed_owned_files_widen_reachability_and_unknown_files_fallback() {
    let repository = testing_repository();
    write_manifest(&repository, manifest_with_three_tasks());
    write(
        repository.join("src/changed.ts"),
        "export const changed = true;\n",
    )
    .expect("changed file must be writable");

    let changed_response = execute_request(request(&repository, Vec::new()));
    assert!(changed_response.ok, "{changed_response:?}");
    let changed_plan = &changed_response
        .result
        .expect("successful response must include a plan")
        .plan;
    let chosen = changed_plan
        .tasks
        .iter()
        .find(|task| task.id == "fixture:chosen")
        .expect("chosen task must be planned");
    assert_eq!(chosen.decision, "run");
    assert_eq!(chosen.reason, "graph-uncertainty-project-fallback");
    assert_eq!(chosen.confidence, "conservative");
    assert!(chosen.widened);
    assert!(!changed_plan.scope.full_fallback);

    write(repository.join("unknown.txt"), "unowned\n").expect("unknown file must be writable");
    let fallback_response = execute_request(request(&repository, Vec::new()));
    assert!(fallback_response.ok, "{fallback_response:?}");
    let fallback_plan = &fallback_response
        .result
        .expect("successful response must include a plan")
        .plan;
    assert!(fallback_plan.scope.full_fallback);
    assert!(
        fallback_plan
            .tasks
            .iter()
            .all(|task| task.decision == "run")
    );
    for fallback_task in &fallback_plan.tasks {
        assert_eq!(fallback_task.reason, "full-fallback");
        let cited = cited_issues(fallback_plan, fallback_task);
        assert!(
            cited
                .iter()
                .any(|issue| issue.code == "unknown-changed-path"
                    && issue.path.as_deref() == Some("unknown.txt")),
            "a complete fallback must cite the change that forced it: {fallback_task:?}"
        );
    }
    remove_dir_all(repository).expect("temporary repository must be removable");
}

#[test]
fn incomplete_full_fallback_is_rejected_before_planning() {
    let repository = testing_repository();
    write_manifest(
        &repository,
        manifest_with_three_tasks().replace(
            "[\"fixture:prepare\", \"fixture:chosen\", \"fixture:always\"]",
            "[\"fixture:prepare\"]",
        ),
    );

    let response = execute_request(request(&repository, Vec::new()));
    assert!(!response.ok);
    assert!(
        response
            .error
            .expect("invalid manifest must include an error")
            .contains("fullFallback.taskIds")
    );
    remove_dir_all(repository).expect("temporary repository must be removable");
}

#[test]
fn unsupported_changed_languages_select_the_manifest_fallback() {
    let repository = testing_repository();
    write_manifest(&repository, manifest_with_three_tasks());
    write(repository.join("src/changed.rs"), "fn changed() {}\n")
        .expect("unsupported fixture source must be written");

    let response = execute_request(request(&repository, Vec::new()));
    assert!(response.ok, "{response:?}");
    let plan = &response
        .result
        .expect("successful response must include a plan")
        .plan;
    assert!(!plan.scope.full_fallback);
    assert!(
        plan.issues
            .iter()
            .any(|issue| issue.code == "reachability-frontend-unavailable")
    );
    remove_dir_all(repository).expect("temporary repository must be removable");
}

#[test]
fn plan_json_is_additive() {
    let repository = testing_repository();
    write_manifest(&repository, manifest_with_three_tasks());
    write(
        repository.join("src/changed.ts"),
        "export const changed = true;\n",
    )
    .expect("changed file must be writable");

    let response = execute_request(request(&repository, Vec::new()));
    assert!(response.ok, "{response:?}");
    let plan = serde_json::to_value(
        &response
            .result
            .expect("successful response must include a plan")
            .plan,
    )
    .expect("a plan must serialize");

    let chosen = plan["tasks"]
        .as_array()
        .expect("tasks must serialize as an array")
        .iter()
        .find(|task| task["id"] == "fixture:chosen")
        .expect("chosen task must be planned")
        .clone();
    for key in ["id", "decision", "reason", "confidence", "widened"] {
        assert!(
            chosen.get(key).is_some(),
            "legacy task key {key} must still be emitted"
        );
    }
    assert_eq!(chosen["project"], "fixture");
    let cause = chosen["causes"]
        .as_array()
        .and_then(|causes| causes.first())
        .expect("a widened task must carry at least one cause")
        .clone();
    assert_eq!(cause["kind"], "issue");
    assert_eq!(
        plan["issues"]
            .as_array()
            .map(|issues| issues.len())
            .unwrap_or_default(),
        1
    );
    let issue = plan["issues"][0].clone();
    for key in ["code", "message"] {
        assert!(
            issue.get(key).is_some(),
            "legacy issue key {key} must still be emitted"
        );
    }
    assert_eq!(issue["code"], "reachability-frontend-unavailable");
    assert_eq!(issue["severity"], "uncertainty");
    assert_eq!(issue["scope"], "workspace");
    assert!(
        issue.get("line").is_none(),
        "an unlocated issue must omit line: {issue}"
    );
    assert!(
        issue.get("path").is_none(),
        "a workspace-wide issue must omit path: {issue}"
    );
    remove_dir_all(repository).expect("temporary repository must be removable");
}

#[test]
fn root_project_owns_every_path() {
    assert!(path_is_inside("packages/core/src/loader.ts", "."));
    assert!(path_is_inside("tooling.config.json", "."));
    assert!(path_is_inside(".", "."));
    assert!(!path_is_inside("packages-other/loader.ts", "packages"));

    let projects = vec![
        declared_project("workspace", "."),
        declared_project("core", "packages/core"),
        declared_project("short", "a"),
    ];

    assert_eq!(
        owning_project_id(&projects, "packages/core/src/loader.ts"),
        Some("core")
    );
    assert_eq!(owning_project_id(&projects, "a/index.ts"), Some("short"));
    assert_eq!(
        owning_project_id(&projects, "tooling.config.json"),
        Some("workspace")
    );
}

fn declared_project(id: &str, root: &str) -> Project {
    Project {
        id: id.to_owned(),
        root: root.to_owned(),
        fallback_dependencies: Vec::new(),
    }
}

fn owning_project_id<'a>(projects: &'a [Project], path: &str) -> Option<&'a str> {
    crate::scope::deepest_project_for_path(projects, path).map(|project| project.id.as_str())
}
