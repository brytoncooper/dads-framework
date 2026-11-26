//! Plan decisions once a precision frontend answers: what a proven symbol reach selects, and how
//! far an uncertainty is allowed to widen.
use super::support::{
    assert_decision, cited_issues, git, request, testing_repository, write_manifest,
};
use crate::graph::{
    ChangedModuleEvidence, DependencyGraph, GraphUncertainty, GraphUncertaintyScope, ImportFact,
    ImportKind, LineColumn, ModuleNode, SourceLocation, SourceSpan, SymbolFact,
};
use crate::{IssueScope, IssueSeverity, TaskCause, execute_request, execute_request_with_graph};
use std::collections::BTreeSet;
use std::fs::{create_dir_all, remove_dir_all, write};
#[test]
fn static_importers_select_their_reachability_tasks_across_projects() {
    let repository = testing_repository();
    create_dir_all(repository.join("app")).expect("application directory must be created");
    create_dir_all(repository.join("lib")).expect("library directory must be created");
    write(repository.join("lib/value.ts"), "export const value = 1;\n")
        .expect("library source must be written");
    write(
        repository.join("app/consumer.ts"),
        "import { value } from '../lib/value'; export const consumer = value;\n",
    )
    .expect("application source must be written");
    git(&repository, &["add", "."]);
    git(&repository, &["commit", "-m", "add graph fixture"]);
    write_manifest(&repository, r#"{
  "schemaVersion": 1,
  "workspace": { "root": ".", "fullFallback": { "taskIds": ["lib:test", "app:test"] } },
  "projects": [
    { "id": "lib", "root": "lib", "fallbackDependencies": [] },
    { "id": "app", "root": "app", "fallbackDependencies": ["lib"] }
  ],
  "tasks": [
    { "id": "lib:test", "project": "lib", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "app:test", "project": "app", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } }
  ]
}"#.to_owned());
    write(repository.join("lib/value.ts"), "export const value = 2;\n")
        .expect("library change must be written");

    let response = execute_request(request(&repository, Vec::new()));
    assert!(response.ok, "{response:?}");
    let plan = &response
        .result
        .expect("successful response must include a plan")
        .plan;
    let application = plan
        .tasks
        .iter()
        .find(|task| task.id == "app:test")
        .expect("application task must be planned");
    assert_eq!(application.decision, "run");
    assert_eq!(application.reason, "full-fallback");
    assert!(plan.scope.full_fallback);
    assert!(
        cited_issues(plan, application)
            .iter()
            .any(|issue| issue.code == "reachability-frontend-unavailable"),
        "missing frontend on multi-project workspace must cite reachability-frontend-unavailable: {application:?}"
    );
    assert!(
        plan.tasks
            .iter()
            .all(|task| task.id.starts_with(&format!("{}:", task.project))),
        "every decision must name its owning project: {:?}",
        plan.tasks
    );

    let graph = DependencyGraph::new(
        vec![
            ModuleNode {
                path: "lib/value.ts".into(),
                language: "typescript".into(),
                declarations: vec![SymbolFact {
                    name: "value".into(),
                    span: SourceSpan { start: 0, end: 24 },
                }],
                references: vec![],
                imports: vec![],
            },
            ModuleNode {
                path: "app/consumer.ts".into(),
                language: "typescript".into(),
                declarations: vec![SymbolFact {
                    name: "consumer".into(),
                    span: SourceSpan { start: 34, end: 70 },
                }],
                references: vec![],
                imports: vec![ImportFact {
                    specifier: "../lib/value".into(),
                    span: SourceSpan { start: 20, end: 34 },
                    kind: ImportKind::Static,
                    type_only: false,
                    requested_symbols: ["value".to_owned()].into_iter().collect(),
                    namespace_import: false,
                    reexport_all: false,
                    reexport_namespace: None,
                    resolved_path: Some("lib/value.ts".into()),
                    position: Some(LineColumn {
                        line: 1,
                        column: 21,
                    }),
                    export_deps: None,
                    member_reads: None,
                }],
            },
        ],
        vec![],
    )
    .with_changed_module_evidence(vec![ChangedModuleEvidence {
        path: "lib/value.ts".into(),
        changed_exports: BTreeSet::from(["value".to_owned()]),
        every_hunk_is_attributed: true,
        semantic_change: true,
        type_only_change: false,
        module_eval_changed: false,
        changed_type_exports: None,
    }]);
    let proven_response = execute_request_with_graph(request(&repository, Vec::new()), Some(graph));
    assert!(proven_response.ok, "{proven_response:?}");
    let proven_plan = &proven_response
        .result
        .expect("successful response must include a plan")
        .plan;
    let library = proven_plan
        .tasks
        .iter()
        .find(|task| task.id == "lib:test")
        .expect("library task must be planned");
    let importer = proven_plan
        .tasks
        .iter()
        .find(|task| task.id == "app:test")
        .expect("application task must be planned");

    assert_eq!(library.reason, "graph-changed-export");
    assert_eq!(library.project, "lib");
    assert!(library.causes.contains(&TaskCause::ChangedPath {
        path: "lib/value.ts".to_owned(),
    }));
    assert!(library.causes.contains(&TaskCause::ChangedExport {
        path: "lib/value.ts".to_owned(),
        symbol: "value".to_owned(),
    }));
    assert_eq!(importer.reason, "graph-symbol-importer");
    assert_eq!(importer.project, "app");
    assert_eq!(
        importer.causes,
        vec![TaskCause::ReachedImport {
            path: "app/consumer.ts".to_owned(),
            line: Some(1),
            column: Some(21),
            imported_from: "lib/value.ts".to_owned(),
            symbols: vec!["value".to_owned()],
        }]
    );
    remove_dir_all(repository).expect("temporary repository must be removable");
}

#[test]
fn graph_uncertainty_widens_only_through_declared_project_dependencies() {
    let repository = testing_repository();
    for directory in ["lib", "app", "unrelated"] {
        create_dir_all(repository.join(directory))
            .expect("fixture project directory must be created");
    }
    write(repository.join("lib/value.ts"), "export const value = 1;\n")
        .expect("library source must be written");
    git(&repository, &["add", "."]);
    git(
        &repository,
        &["commit", "-m", "add scoped fallback fixture"],
    );
    write_manifest(
            &repository,
            r#"{
  "schemaVersion": 1,
  "workspace": { "root": ".", "fullFallback": { "taskIds": ["lib:test", "app:test", "unrelated:test"] } },
  "projects": [
    { "id": "lib", "root": "lib", "fallbackDependencies": [] },
    { "id": "app", "root": "app", "fallbackDependencies": ["lib"] },
    { "id": "unrelated", "root": "unrelated", "fallbackDependencies": [] }
  ],
  "tasks": [
    { "id": "lib:test", "project": "lib", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "app:test", "project": "app", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "unrelated:test", "project": "unrelated", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } }
  ]
}"#
            .to_owned(),
        );
    write(repository.join("lib/value.ts"), "export const value = 2;\n")
        .expect("library change must be written");
    let graph = DependencyGraph::new(
        vec![
            ModuleNode {
                path: "lib/value.ts".into(),
                language: "typescript".into(),
                declarations: vec![SymbolFact {
                    name: "value".into(),
                    span: SourceSpan { start: 0, end: 1 },
                }],
                references: vec![],
                imports: vec![],
            },
            ModuleNode {
                path: "app/consumer.ts".into(),
                language: "typescript".into(),
                declarations: vec![SymbolFact {
                    name: "consumer".into(),
                    span: SourceSpan { start: 0, end: 1 },
                }],
                references: vec![],
                imports: vec![ImportFact {
                    specifier: "../lib/value".into(),
                    span: SourceSpan { start: 0, end: 1 },
                    kind: ImportKind::Static,
                    type_only: false,
                    requested_symbols: ["value".to_owned()].into_iter().collect(),
                    namespace_import: false,
                    reexport_all: false,
                    reexport_namespace: None,
                    resolved_path: Some("lib/value.ts".into()),
                    position: None,
                    export_deps: None,
                    member_reads: None,
                }],
            },
        ],
        vec![GraphUncertainty {
            path: "app/consumer.ts".into(),
            code: "fixture-uncertainty".into(),
            message: "The app edge needs project-level widening.".into(),
            scope: GraphUncertaintyScope::ReachedModule,
            location: None,
        }],
    )
    .with_changed_module_evidence(vec![ChangedModuleEvidence {
        path: "lib/value.ts".into(),
        changed_exports: BTreeSet::from(["value".to_owned()]),
        every_hunk_is_attributed: true,
        semantic_change: true,
        type_only_change: false,
        module_eval_changed: false,
        changed_type_exports: None,
    }]);

    let response =
        execute_request_with_graph(request(&repository, Vec::new()), Some(graph.clone()));
    assert!(response.ok, "{response:?}");
    let plan = &response
        .result
        .expect("successful response must include a plan")
        .plan;

    assert!(!plan.scope.full_fallback);
    assert_decision(plan, "lib:test", "run");
    assert_decision(plan, "app:test", "run");
    assert_decision(plan, "unrelated:test", "skip-proven-unaffected");
    let app = plan
        .tasks
        .iter()
        .find(|task| task.id == "app:test")
        .expect("app task must be planned");
    assert_eq!(app.reason, "graph-uncertainty-project-fallback");
    assert!(app.widened);
    assert_eq!(app.project, "app");
    let cited = cited_issues(plan, app);
    let [issue] = cited.as_slice() else {
        panic!("a widened task must cite exactly the issue that widened it: {app:?}");
    };
    assert_eq!(issue.code, "fixture-uncertainty");
    assert_eq!(issue.path.as_deref(), Some("app/consumer.ts"));
    assert_eq!(issue.project.as_deref(), Some("app"));
    assert_eq!(issue.severity, IssueSeverity::Uncertainty);
    assert_eq!(issue.scope, IssueScope::Module);
    assert!(
        !app.causes
            .iter()
            .any(|cause| matches!(cause, TaskCause::FallbackDependency { .. })),
        "an uncertainty inside the task's own project needs no fallback dependency"
    );

    let dependency_graph = DependencyGraph::new(
        graph.materialize_modules(),
        vec![GraphUncertainty {
            path: "lib/value.ts".into(),
            code: "fixture-uncertainty".into(),
            message: "The library edge needs project-level widening.".into(),
            scope: GraphUncertaintyScope::ReachedModule,
            location: None,
        }],
    )
    .with_changed_module_evidence(vec![ChangedModuleEvidence {
        path: "lib/value.ts".into(),
        changed_exports: BTreeSet::from(["value".to_owned()]),
        every_hunk_is_attributed: true,
        semantic_change: true,
        type_only_change: false,
        module_eval_changed: false,
        changed_type_exports: None,
    }]);
    let dependency_response =
        execute_request_with_graph(request(&repository, Vec::new()), Some(dependency_graph));
    assert!(dependency_response.ok, "{dependency_response:?}");
    let dependency_plan = &dependency_response
        .result
        .expect("successful response must include a plan")
        .plan;
    let widened_dependent = dependency_plan
        .tasks
        .iter()
        .find(|task| task.id == "app:test")
        .expect("app task must be planned");
    assert_eq!(
        widened_dependent.reason,
        "graph-uncertainty-project-fallback"
    );
    assert!(
        widened_dependent
            .causes
            .contains(&TaskCause::FallbackDependency {
                project: "lib".to_owned(),
            })
    );
    let dependency_issues = cited_issues(dependency_plan, widened_dependent);
    assert!(
        dependency_issues
            .iter()
            .any(|issue| issue.code == "fixture-uncertainty"
                && issue.project.as_deref() == Some("lib")),
        "a dependent must cite the dependency's own widening issue: {widened_dependent:?}"
    );
    assert_decision(dependency_plan, "unrelated:test", "skip-proven-unaffected");

    let mut nodes_with_unowned_importer = graph.materialize_modules();
    nodes_with_unowned_importer.push(ModuleNode {
        path: "generated/consumer.ts".into(),
        language: "typescript".into(),
        declarations: vec![],
        references: vec![],
        imports: vec![ImportFact {
            specifier: "../lib/value".into(),
            span: SourceSpan { start: 0, end: 1 },
            kind: ImportKind::Static,
            type_only: false,
            requested_symbols: ["value".to_owned()].into_iter().collect(),
            namespace_import: false,
            reexport_all: false,
            reexport_namespace: None,
            resolved_path: Some("lib/value.ts".into()),
            position: None,
            export_deps: None,
            member_reads: None,
        }],
    });
    let unowned_graph = DependencyGraph::new(nodes_with_unowned_importer, vec![])
        .with_changed_module_evidence(vec![ChangedModuleEvidence {
            path: "lib/value.ts".into(),
            changed_exports: BTreeSet::from(["value".to_owned()]),
            every_hunk_is_attributed: true,
            semantic_change: true,
            type_only_change: false,
            module_eval_changed: false,
            changed_type_exports: None,
        }]);
    let full_fallback_response =
        execute_request_with_graph(request(&repository, Vec::new()), Some(unowned_graph));
    assert!(full_fallback_response.ok, "{full_fallback_response:?}");
    let full_fallback_plan = &full_fallback_response
        .result
        .expect("successful fallback response must include a plan")
        .plan;
    assert!(full_fallback_plan.scope.full_fallback);
    assert_eq!(full_fallback_plan.counts.run, 3);
    assert!(
        full_fallback_plan
            .issues
            .iter()
            .any(|issue| issue.code == "reachable-module-unowned")
    );
    remove_dir_all(repository).expect("temporary repository must be removable");
}

#[test]
fn unreached_unbounded_import_uncertainty_widens_its_owner_project() {
    let repository = testing_repository();
    for directory in ["lib", "dynamic-loader"] {
        create_dir_all(repository.join(directory))
            .expect("fixture project directory must be created");
    }
    write(repository.join("lib/value.ts"), "export const value = 1;\n")
        .expect("library source must be written");
    write(
        repository.join("dynamic-loader/loader.ts"),
        "export async function load() {}\n",
    )
    .expect("dynamic loader source must be written");
    git(&repository, &["add", "."]);
    git(
        &repository,
        &["commit", "-m", "add unbounded import fixture"],
    );
    write_manifest(
            &repository,
            r#"{
  "schemaVersion": 1,
  "workspace": { "root": ".", "fullFallback": { "taskIds": ["lib:test", "dynamic-loader:test"] } },
  "projects": [
    { "id": "lib", "root": "lib", "fallbackDependencies": [] },
    { "id": "dynamic-loader", "root": "dynamic-loader", "fallbackDependencies": [] }
  ],
  "tasks": [
    { "id": "lib:test", "project": "lib", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "dynamic-loader:test", "project": "dynamic-loader", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } }
  ]
}"#
            .to_owned(),
        );
    write(repository.join("lib/value.ts"), "export const value = 2;\n")
        .expect("library change must be written");
    let graph = DependencyGraph::new(
        vec![
            ModuleNode {
                path: "lib/value.ts".into(),
                language: "typescript".into(),
                declarations: vec![SymbolFact {
                    name: "value".into(),
                    span: SourceSpan { start: 0, end: 1 },
                }],
                references: vec![],
                imports: vec![],
            },
            ModuleNode {
                path: "dynamic-loader/loader.ts".into(),
                language: "typescript".into(),
                declarations: vec![],
                references: vec![],
                imports: vec![],
            },
        ],
        vec![GraphUncertainty {
            path: "dynamic-loader/loader.ts".into(),
            code: "nonliteral-dynamic-import".into(),
            message: "A dynamic import does not have a static module specifier.".into(),
            scope: GraphUncertaintyScope::WholeWorkspace,
            location: Some(SourceLocation {
                span: SourceSpan { start: 46, end: 58 },
                position: LineColumn {
                    line: 3,
                    column: 12,
                },
            }),
        }],
    )
    .with_changed_module_evidence(vec![ChangedModuleEvidence {
        path: "lib/value.ts".into(),
        changed_exports: BTreeSet::from(["value".to_owned()]),
        every_hunk_is_attributed: true,
        semantic_change: true,
        type_only_change: false,
        module_eval_changed: false,
        changed_type_exports: None,
    }]);

    let response = execute_request_with_graph(request(&repository, Vec::new()), Some(graph));
    assert!(response.ok, "{response:?}");
    let plan = &response
        .result
        .expect("successful response must include a plan")
        .plan;
    let dynamic_loader = plan
        .tasks
        .iter()
        .find(|task| task.id == "dynamic-loader:test")
        .expect("dynamic loader task must be planned");
    assert_eq!(dynamic_loader.decision, "run");
    assert_eq!(dynamic_loader.reason, "graph-uncertainty-project-fallback");
    assert!(dynamic_loader.widened);
    let cited = cited_issues(plan, dynamic_loader);
    let [issue] = cited.as_slice() else {
        panic!("the widened loader must cite its located uncertainty: {dynamic_loader:?}");
    };
    assert_eq!(issue.code, "nonliteral-dynamic-import");
    assert_eq!(issue.path.as_deref(), Some("dynamic-loader/loader.ts"));
    assert_eq!(issue.project.as_deref(), Some("dynamic-loader"));
    assert_eq!(issue.line, Some(3));
    assert_eq!(issue.column, Some(12));
    assert_eq!(issue.scope, IssueScope::Workspace);
    assert_eq!(issue.severity, IssueSeverity::Uncertainty);
    remove_dir_all(repository).expect("temporary repository must be removable");
}

#[test]
fn uncovered_changed_path_still_widens_whole_workspace_uncertainty() {
    let repository = testing_repository();
    for directory in ["lib", "dynamic-loader"] {
        create_dir_all(repository.join(directory))
            .expect("fixture project directory must be created");
    }
    write(repository.join("lib/schema.sql"), "select 1;\n")
        .expect("uncovered asset must be written");
    write(
        repository.join("dynamic-loader/loader.ts"),
        "export async function load() {}\n",
    )
    .expect("dynamic loader source must be written");
    git(&repository, &["add", "."]);
    git(
        &repository,
        &[
            "commit",
            "-m",
            "add uncovered asset with workspace uncertainty",
        ],
    );
    write_manifest(
        &repository,
        r#"{
  "schemaVersion": 1,
  "workspace": { "root": ".", "fullFallback": { "taskIds": ["lib:test", "dynamic-loader:test"] } },
  "projects": [
    { "id": "lib", "root": "lib", "fallbackDependencies": [] },
    { "id": "dynamic-loader", "root": "dynamic-loader", "fallbackDependencies": [] }
  ],
  "tasks": [
    { "id": "lib:test", "project": "lib", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } },
    { "id": "dynamic-loader:test", "project": "dynamic-loader", "kind": "test", "execution": { "executable": "true" }, "dependsOn": [], "impact": { "mode": "reachability" } }
  ]
}"#
        .to_owned(),
    );
    write(repository.join("lib/schema.sql"), "select 2;\n")
        .expect("uncovered asset change must be written");
    let graph = DependencyGraph::new(
        vec![ModuleNode {
            path: "dynamic-loader/loader.ts".into(),
            language: "typescript".into(),
            declarations: vec![],
            references: vec![],
            imports: vec![],
        }],
        vec![GraphUncertainty {
            path: "dynamic-loader/loader.ts".into(),
            code: "nonliteral-dynamic-import".into(),
            message: "A dynamic import does not have a static module specifier.".into(),
            scope: GraphUncertaintyScope::WholeWorkspace,
            location: None,
        }],
    );

    let response = execute_request_with_graph(request(&repository, Vec::new()), Some(graph));
    assert!(response.ok, "{response:?}");
    let plan = &response
        .result
        .expect("successful response must include a plan")
        .plan;
    assert_decision(plan, "lib:test", "run");
    assert_decision(plan, "dynamic-loader:test", "run");
    remove_dir_all(repository).expect("temporary repository must be removable");
}
