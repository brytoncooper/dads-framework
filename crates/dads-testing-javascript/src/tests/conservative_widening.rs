use super::fixtures::{commit_fixture, git, request};
use crate::analyze_request;
use crate::frontend::incremental_request;
use dads_testing_core::execute_request_with_graph;
use dads_testing_core::graph::{DependencyGraph, GraphUncertainty, GraphUncertaintyScope};
use std::fs::{create_dir_all, remove_dir_all, write};

#[test]
fn rebuilds_an_uncertain_snapshot_instead_of_dropping_its_uncertainties() {
    let root = std::env::temp_dir().join("dads-testing-javascript-uncertain-snapshot");
    let previous = DependencyGraph::new(
        vec![],
        vec![GraphUncertainty {
            path: "src/dynamic.ts".to_owned(),
            code: "nonliteral-dynamic-import".to_owned(),
            message: "A dynamic import remains uncertain.".to_owned(),
            scope: GraphUncertaintyScope::WholeWorkspace,
            location: None,
        }],
    );

    let error = incremental_request(&request(&root), previous, &[])
        .expect_err("an uncertain graph must be rebuilt");

    assert!(error.contains("requires a full rebuild"));
}

#[test]
fn bounds_an_unresolved_bare_alias_to_its_declared_project_dependents() {
    let root = std::env::temp_dir().join("dads-testing-javascript-bare-alias-fallback");
    let _ = remove_dir_all(&root);
    create_dir_all(root.join("src")).expect("fixture source directory must be created");
    write(
        root.join("src/importer.ts"),
        "import { value } from '@workspace/missing'; export { value };\n",
    )
    .expect("fixture importer must be written");
    write(
        root.join("dads.testing.json"),
        r#"{
  "schemaVersion": 1,
  "workspace": { "fullFallback": { "taskIds": ["app:test"] } },
  "projects": [
    { "id": "app", "root": "src", "fallbackDependencies": [] }
  ],
  "tasks": [
    { "id": "app:test", "project": "app", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } }
  ]
}"#,
    )
    .expect("testing manifest must be written");
    commit_fixture(&root);
    write(
        root.join("src/importer.ts"),
        "import { value } from '@workspace/missing'; export { value }; // changed\n",
    )
    .expect("fixture importer change must be written");

    let request = request(&root);
    let graph = analyze_request(&request).expect("working-tree graph must be available");
    let response = execute_request_with_graph(request, Some(graph));
    assert!(response.ok, "{response:?}");
    let plan = &response
        .result
        .expect("successful response must include a plan")
        .plan;
    assert!(!plan.scope.full_fallback);
    assert!(
        plan.issues
            .iter()
            .any(|issue| issue.code == "unresolved-bare-module")
    );
    assert!(plan.tasks.iter().any(|task| {
        task.id == "app:test" && task.reason == "graph-uncertainty-project-fallback" && task.widened
    }));
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn keeps_an_unexported_same_line_change_conservative() {
    let root = std::env::temp_dir().join("dads-testing-javascript-same-line-unexported");
    let _ = remove_dir_all(&root);
    for directory in ["lib", "app-a", "app-b"] {
        create_dir_all(root.join(directory)).expect("fixture project directory must be created");
    }
    write(
        root.join("lib/leaf.ts"),
        "const internal = 1; export const a = 1;\nexport const b = internal;\n",
    )
    .expect("fixture leaf must be written");
    write(
        root.join("app-a/index.ts"),
        "import { a } from '../lib/leaf'; export const usesA = a;\n",
    )
    .expect("fixture A importer must be written");
    write(
        root.join("app-b/index.ts"),
        "import { b } from '../lib/leaf'; export const usesB = b;\n",
    )
    .expect("fixture B importer must be written");
    write(root.join("dads.testing.json"), r#"{
  "schemaVersion": 1,
  "workspace": { "fullFallback": { "taskIds": ["lib:test", "app-a:test", "app-b:test"] } },
  "projects": [
    { "id": "lib", "root": "lib", "fallbackDependencies": [] },
    { "id": "app-a", "root": "app-a", "fallbackDependencies": ["lib"] },
    { "id": "app-b", "root": "app-b", "fallbackDependencies": ["lib"] }
  ],
  "tasks": [
    { "id": "lib:test", "project": "lib", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "app-a:test", "project": "app-a", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "app-b:test", "project": "app-b", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } }
  ]
}"#)
        .expect("testing manifest must be written");
    commit_fixture(&root);
    write(
        root.join("lib/leaf.ts"),
        "const internal = 2; export const a = 1;\nexport const b = internal;\n",
    )
    .expect("fixture internal change must be written");

    let request = request(&root);
    let graph = analyze_request(&request).expect("working-tree graph must be available");
    let reachable = graph.symbol_reachability_from(["lib/leaf.ts".to_owned()]);
    let response = execute_request_with_graph(request, Some(graph));
    assert!(response.ok, "{response:?}");
    let plan = &response
        .result
        .expect("successful response must include a plan")
        .plan;
    let app_b_task = plan
        .tasks
        .iter()
        .find(|task| task.id == "app-b:test")
        .expect("app B task must exist");

    assert_eq!(app_b_task.decision, "run");
    assert_eq!(app_b_task.reason, "graph-uncertainty-project-fallback");
    assert!(app_b_task.widened);
    assert!(
        reachable
            .uncertainties
            .iter()
            .any(|uncertainty| uncertainty.code == "unattributed-module-change")
    );
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn keeps_semantic_whitespace_changed_in_unexported_code_conservative() {
    let root = std::env::temp_dir().join("dads-testing-javascript-unexported-semantic-whitespace");
    let _ = remove_dir_all(&root);
    for directory in ["lib", "app-b"] {
        create_dir_all(root.join(directory)).expect("fixture project directory must be created");
    }
    write(
        root.join("lib/leaf.ts"),
        "function internal() {\n  return\n  1;\n}\nexport const b = internal();\n",
    )
    .expect("fixture leaf must be written");
    write(
        root.join("app-b/index.ts"),
        "import { b } from '../lib/leaf'; export const usesB = b;\n",
    )
    .expect("fixture B importer must be written");
    write(root.join("dads.testing.json"), r#"{
  "schemaVersion": 1,
  "workspace": { "fullFallback": { "taskIds": ["lib:test", "app-b:test"] } },
  "projects": [
    { "id": "lib", "root": "lib", "fallbackDependencies": [] },
    { "id": "app-b", "root": "app-b", "fallbackDependencies": ["lib"] }
  ],
  "tasks": [
    { "id": "lib:test", "project": "lib", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "app-b:test", "project": "app-b", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } }
  ]
}"#)
        .expect("testing manifest must be written");
    commit_fixture(&root);
    write(
        root.join("lib/leaf.ts"),
        "function internal() {\n  return 1;\n}\nexport const b = internal();\n",
    )
    .expect("fixture semantic whitespace change must be written");

    let request = request(&root);
    let graph = analyze_request(&request).expect("working-tree graph must be available");
    let reachable = graph.symbol_reachability_from(["lib/leaf.ts".to_owned()]);
    let response = execute_request_with_graph(request, Some(graph));
    assert!(response.ok, "{response:?}");
    let plan = &response
        .result
        .expect("successful response must include a plan")
        .plan;
    let app_b_task = plan
        .tasks
        .iter()
        .find(|task| task.id == "app-b:test")
        .expect("app B task must exist");

    assert_eq!(app_b_task.decision, "run");
    assert_eq!(app_b_task.reason, "graph-uncertainty-project-fallback");
    assert!(app_b_task.widened);
    assert!(
        reachable
            .uncertainties
            .iter()
            .any(|uncertainty| uncertainty.code == "unattributed-module-change")
    );
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn keeps_a_replacement_with_an_unexported_old_side_conservative() {
    let root = std::env::temp_dir().join("dads-testing-javascript-unexported-replacement");
    let _ = remove_dir_all(&root);
    for directory in ["lib", "app-a", "app-b"] {
        create_dir_all(root.join(directory)).expect("fixture project directory must be created");
    }
    write(
        root.join("lib/leaf.ts"),
        "function helper() {\n  return 1;\n}\n\nexport const b = 1;\n",
    )
    .expect("fixture leaf must be written");
    write(
        root.join("app-a/index.ts"),
        "import { a } from '../lib/leaf'; export const usesA = a;\n",
    )
    .expect("fixture A importer must be written");
    write(
        root.join("app-b/index.ts"),
        "import { b } from '../lib/leaf'; export const usesB = b;\n",
    )
    .expect("fixture B importer must be written");
    write(root.join("dads.testing.json"), r#"{
  "schemaVersion": 1,
  "workspace": { "fullFallback": { "taskIds": ["lib:test", "app-a:test", "app-b:test"] } },
  "projects": [
    { "id": "lib", "root": "lib", "fallbackDependencies": [] },
    { "id": "app-a", "root": "app-a", "fallbackDependencies": ["lib"] },
    { "id": "app-b", "root": "app-b", "fallbackDependencies": ["lib"] }
  ],
  "tasks": [
    { "id": "lib:test", "project": "lib", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "app-a:test", "project": "app-a", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "app-b:test", "project": "app-b", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } }
  ]
}"#)
        .expect("testing manifest must be written");
    commit_fixture(&root);
    write(
        root.join("lib/leaf.ts"),
        "export const a = 1;\n\nexport const b = 1;\n",
    )
    .expect("fixture replacement must be written");

    let graph = analyze_request(&request(&root)).expect("replacement graph must be available");
    let reachable = graph.symbol_reachability_from(["lib/leaf.ts".to_owned()]);

    assert!(!reachable.paths.contains("app-b/index.ts"));
    assert!(
        reachable
            .uncertainties
            .iter()
            .any(|uncertainty| { uncertainty.code == "unattributed-module-change" })
    );
    let response = execute_request_with_graph(request(&root), Some(graph));
    assert!(response.ok, "{response:?}");
    let plan = &response
        .result
        .expect("successful response must include a plan")
        .plan;
    let app_b_task = plan
        .tasks
        .iter()
        .find(|task| task.id == "app-b:test")
        .expect("app B task must exist");
    assert_eq!(app_b_task.decision, "run");
    assert_eq!(app_b_task.reason, "graph-uncertainty-project-fallback");
    assert!(app_b_task.widened);
    remove_dir_all(root).expect("fixture source directory must be removed");
}

#[test]
fn symbol_evidence_selects_only_the_task_for_the_matching_importer() {
    let root = std::env::temp_dir().join("dads-testing-javascript-symbol-plan");
    let _ = remove_dir_all(&root);
    for directory in ["lib", "app-a", "app-b"] {
        create_dir_all(root.join(directory)).expect("fixture project directory must be created");
    }
    write(
        root.join("lib/leaf.ts"),
        "export const a = 1;\nexport const b = 1;\n",
    )
    .expect("fixture leaf must be written");
    write(
        root.join("app-a/index.ts"),
        "import { a } from '../lib/leaf'; export const usesA = a;\n",
    )
    .expect("fixture A importer must be written");
    write(
        root.join("app-b/index.ts"),
        "import { b } from '../lib/leaf'; export const usesB = b;\n",
    )
    .expect("fixture B importer must be written");
    write(root.join("dads.testing.json"), r#"{
  "schemaVersion": 1,
  "workspace": { "fullFallback": { "taskIds": ["lib:test", "app-a:test", "app-b:test"] } },
  "projects": [
    { "id": "lib", "root": "lib", "fallbackDependencies": [] },
    { "id": "app-a", "root": "app-a", "fallbackDependencies": [] },
    { "id": "app-b", "root": "app-b", "fallbackDependencies": [] }
  ],
  "tasks": [
    { "id": "lib:test", "project": "lib", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "app-a:test", "project": "app-a", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "app-b:test", "project": "app-b", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } }
  ]
}"#).expect("testing manifest must be written");
    git(&root, &["init"]);
    git(&root, &["config", "user.email", "testing@example.com"]);
    git(&root, &["config", "user.name", "Dads Testing"]);
    git(&root, &["add", "."]);
    git(&root, &["commit", "-m", "initial"]);
    write(
        root.join("lib/leaf.ts"),
        "export const a = 2;\nexport const b = 1;\n",
    )
    .expect("fixture export change must be written");

    let request = request(&root);
    let graph = analyze_request(&request).expect("working-tree graph must be available");
    let response = execute_request_with_graph(request, Some(graph));
    assert!(response.ok, "{response:?}");
    let plan = &response
        .result
        .expect("successful response must include a plan")
        .plan;
    let a_task = plan
        .tasks
        .iter()
        .find(|task| task.id == "app-a:test")
        .expect("A task must exist");
    let b_task = plan
        .tasks
        .iter()
        .find(|task| task.id == "app-b:test")
        .expect("B task must exist");
    assert_eq!(a_task.decision, "run");
    assert_eq!(a_task.reason, "graph-symbol-importer");
    assert_eq!(b_task.decision, "skip-proven-unaffected");
    remove_dir_all(root).expect("fixture source directory must be removed");
}
