//! When a graph is worth analyzing, and the proof that it changes nothing when it is not.
//!
//! `graph_analysis_can_change_the_plan` lets a caller skip parsing the whole workspace. That is
//! only sound if a manifest without a `reachability` task really cannot read a graph, so these
//! tests plan the same request twice — once with a graph that reaches everywhere, once with none —
//! and require the two emitted plans to be byte-identical.
use super::support::{git, request, testing_repository, write_manifest};
use crate::graph::{DependencyGraph, ImportFact, ImportKind, ModuleNode, SourceSpan, SymbolFact};
use crate::{NativeRequest, execute_request_with_graph, graph_analysis_can_change_the_plan};
use std::collections::BTreeSet;
use std::fs::{create_dir_all, remove_dir_all, write};

/// Two projects, and not one `reachability` task between them: `always`, `changed-files`, and
/// `project` impact are exactly the modes that decide without a graph.
const MANIFEST_WITHOUT_A_GRAPH_READER: &str = r#"{
  "schemaVersion": 1,
  "workspace": { "root": ".", "fullFallback": { "taskIds": ["fixture:always", "fixture:changed-files", "fixture:project", "leaf:project"] } },
  "projects": [
    { "id": "fixture", "root": "src", "fallbackDependencies": [] },
    { "id": "leaf", "root": "leaf", "fallbackDependencies": ["fixture"] }
  ],
  "tasks": [
    { "id": "fixture:always", "project": "fixture", "kind": "custom", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "always" } },
    { "id": "fixture:changed-files", "project": "fixture", "kind": "lint", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "changed-files", "paths": ["src"] } },
    { "id": "fixture:project", "project": "fixture", "kind": "test", "execution": { "executable": "true" }, "dependsOn": ["fixture:changed-files"], "impact": { "mode": "project" } },
    { "id": "leaf:project", "project": "leaf", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "project" } }
  ]
}"#;

/// The same declaration with one task switched to `reachability`.
const MANIFEST_WITH_A_GRAPH_READER: &str = r#"{
  "schemaVersion": 1,
  "workspace": { "root": ".", "fullFallback": { "taskIds": ["fixture:always", "fixture:reachability"] } },
  "projects": [{ "id": "fixture", "root": "src", "fallbackDependencies": [] }],
  "tasks": [
    { "id": "fixture:always", "project": "fixture", "kind": "custom", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "always" } },
    { "id": "fixture:reachability", "project": "fixture", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } }
  ]
}"#;

#[test]
fn a_manifest_without_a_reachability_task_needs_no_graph_analysis() {
    let repository = testing_repository();
    write_manifest(&repository, MANIFEST_WITHOUT_A_GRAPH_READER.to_owned());

    assert!(!graph_analysis_can_change_the_plan(&request(
        &repository,
        Vec::new()
    )));
    remove_dir_all(repository).expect("temporary repository must be removable");
}

#[test]
fn one_reachability_task_is_enough_to_need_graph_analysis() {
    let repository = testing_repository();
    write_manifest(&repository, MANIFEST_WITH_A_GRAPH_READER.to_owned());

    assert!(graph_analysis_can_change_the_plan(&request(
        &repository,
        Vec::new()
    )));
    remove_dir_all(repository).expect("temporary repository must be removable");
}

/// A manifest the core cannot read decides nothing here: the request is refused later, with the
/// real reason, and until then analysis stays on.
#[test]
fn an_unreadable_manifest_still_needs_graph_analysis() {
    let repository = testing_repository();

    assert!(graph_analysis_can_change_the_plan(&request(
        &repository,
        Vec::new()
    )));
    remove_dir_all(repository).expect("temporary repository must be removable");
}

#[test]
fn an_owned_change_plans_identically_with_and_without_a_graph() {
    let repository = graphless_repository();
    write(
        repository.join("src/initial.ts"),
        "export const initial = false;\n",
    )
    .expect("owned change must be writable");

    assert_plan_is_identical_without_a_graph(&repository, Vec::new());
    remove_dir_all(repository).expect("temporary repository must be removable");
}

#[test]
fn an_unowned_change_still_selects_the_complete_fallback_without_a_graph() {
    let repository = graphless_repository();
    write(repository.join("loose.ts"), "export const loose = true;\n")
        .expect("unowned change must be writable");

    let plan = assert_plan_is_identical_without_a_graph(&repository, Vec::new());
    assert!(
        plan["scope"]["fullFallback"] == serde_json::Value::Bool(true),
        "{plan}"
    );
    assert_eq!(plan["counts"]["skipProvenUnaffected"], 0, "{plan}");
    remove_dir_all(repository).expect("temporary repository must be removable");
}

#[test]
fn a_direct_task_input_still_selects_its_closure_without_a_graph() {
    let repository = graphless_repository();

    let plan =
        assert_plan_is_identical_without_a_graph(&repository, vec!["fixture:project".to_owned()]);
    assert_eq!(plan["counts"]["run"], 3, "{plan}");
    remove_dir_all(repository).expect("temporary repository must be removable");
}

/// Plans the request twice — with a graph that reaches every fixture module, and with none — and
/// requires the two emitted plans to serialize to the same bytes. Returns that plan.
fn assert_plan_is_identical_without_a_graph(
    repository: &std::path::Path,
    task_ids: Vec<String>,
) -> serde_json::Value {
    let analyzed = plan_json(
        request(repository, task_ids.clone()),
        Some(reaching_graph()),
    );
    let skipped = plan_json(request(repository, task_ids), None);
    assert_eq!(
        serde_json::to_string(&analyzed).expect("an analyzed plan must serialize"),
        serde_json::to_string(&skipped).expect("a skipped plan must serialize"),
        "skipping graph analysis must not change the plan"
    );
    skipped
}

fn plan_json(request: NativeRequest, graph: Option<DependencyGraph>) -> serde_json::Value {
    let response = execute_request_with_graph(request, graph);
    assert!(response.ok, "{response:?}");
    serde_json::to_value(
        &response
            .result
            .expect("a successful response must carry a plan")
            .plan,
    )
    .expect("a plan must serialize")
}

/// A graph in which the leaf project imports the changed fixture module, so any plan that read it
/// would widen past what the changed paths alone prove.
fn reaching_graph() -> DependencyGraph {
    DependencyGraph::new(
        vec![
            ModuleNode {
                path: "src/initial.ts".to_owned(),
                language: "typescript".to_owned(),
                declarations: vec![SymbolFact {
                    name: "initial".to_owned(),
                    span: SourceSpan { start: 0, end: 1 },
                }],
                references: Vec::new(),
                imports: Vec::new(),
            },
            ModuleNode {
                path: "leaf/reader.ts".to_owned(),
                language: "typescript".to_owned(),
                declarations: Vec::new(),
                references: vec![SymbolFact {
                    name: "initial".to_owned(),
                    span: SourceSpan { start: 0, end: 1 },
                }],
                imports: vec![ImportFact {
                    specifier: "../src/initial".to_owned(),
                    span: SourceSpan { start: 0, end: 1 },
                    kind: ImportKind::Static,
                    type_only: false,
                    requested_symbols: BTreeSet::from(["initial".to_owned()]),
                    namespace_import: false,
                    reexport_all: false,
                    resolved_path: Some("src/initial.ts".to_owned()),
                    position: None,
                }],
            },
        ],
        Vec::new(),
    )
}

/// The fixture repository the graphless manifest describes, with the leaf module committed.
fn graphless_repository() -> std::path::PathBuf {
    let repository = testing_repository();
    create_dir_all(repository.join("leaf")).expect("leaf directory must be created");
    write(
        repository.join("leaf/reader.ts"),
        "import { initial } from \"../src/initial\";\nexport const reader = initial;\n",
    )
    .expect("leaf module must be writable");
    git(&repository, &["add", "."]);
    git(&repository, &["commit", "-m", "add leaf project"]);
    write_manifest(&repository, MANIFEST_WITHOUT_A_GRAPH_READER.to_owned());
    repository
}
