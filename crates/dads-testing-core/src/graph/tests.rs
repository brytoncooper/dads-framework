#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::too_many_lines
)]
use super::*;
use std::collections::BTreeSet;

#[test]
fn compact_graph_round_trips_patch_and_propagates_three_hops() {
    let a = node("a", "a", None);
    let b = node("b", "b", Some(("a", "a")));
    let c = node("c", "c", Some(("b", "b")));
    let g = DependencyGraph::new(vec![a, b, c], vec![]).with_changed_module_evidence(vec![
        ChangedModuleEvidence {
            path: "a".into(),
            changed_exports: ["a".to_owned()].into_iter().collect(),
            every_hunk_is_attributed: true,
            semantic_change: true,
            type_only_change: false,
            module_eval_changed: false,
        },
    ]);
    let r = g.symbol_reachability_from(["a".into()]);
    assert!(r.paths.contains("c"));
    let g = g.patch_modules(vec![node("d", "d", None)], vec![], vec![]);
    assert!(g.contains_path("d"));
    assert_eq!(g.materialize_modules().len(), 4)
}
#[test]
fn literal_runtime_import_reaches_its_importer_without_named_symbols() {
    let mut importer = node("consumer", "consumer", None);
    importer.imports.push(ImportFact {
        specifier: "leaf".into(),
        span: SourceSpan { start: 0, end: 1 },
        kind: ImportKind::Runtime,
        type_only: false,
        requested_symbols: BTreeSet::new(),
        namespace_import: false,
        reexport_all: false,
        reexport_namespace: None,
        resolved_path: Some("leaf".into()),
        position: None,
        export_deps: None,
        member_reads: None,
    });
    let graph = DependencyGraph::new(vec![node("leaf", "value", None), importer], vec![])
        .with_changed_module_evidence(vec![ChangedModuleEvidence {
            path: "leaf".into(),
            changed_exports: ["value".to_owned()].into_iter().collect(),
            every_hunk_is_attributed: true,
            semantic_change: true,
            type_only_change: false,
            module_eval_changed: false,
        }]);
    assert!(
        graph
            .symbol_reachability_from(["leaf".into()])
            .paths
            .contains("consumer")
    );
}

#[test]
fn export_star_preserves_the_changed_symbol_for_downstream_importers() {
    let leaf = ModuleNode {
        path: "leaf".into(),
        language: "fixture".into(),
        declarations: vec![
            SymbolFact {
                name: "changed".into(),
                span: SourceSpan { start: 0, end: 1 },
            },
            SymbolFact {
                name: "unchanged".into(),
                span: SourceSpan { start: 2, end: 3 },
            },
        ],
        references: vec![],
        imports: vec![],
    };
    let barrel = ModuleNode {
        path: "barrel".into(),
        language: "fixture".into(),
        declarations: vec![],
        references: vec![],
        imports: vec![ImportFact {
            specifier: "leaf".into(),
            span: SourceSpan { start: 0, end: 1 },
            kind: ImportKind::ReExport,
            type_only: false,
            requested_symbols: BTreeSet::new(),
            namespace_import: false,
            reexport_all: true,
            reexport_namespace: None,
            resolved_path: Some("leaf".into()),
            position: None,
            export_deps: None,
            member_reads: None,
        }],
    };
    let changed_consumer = node("changed-consumer", "result", Some(("barrel", "changed")));
    let unchanged_consumer = node(
        "unchanged-consumer",
        "result",
        Some(("barrel", "unchanged")),
    );
    let graph = DependencyGraph::new(
        vec![leaf, barrel, changed_consumer, unchanged_consumer],
        vec![],
    )
    .with_changed_module_evidence(vec![ChangedModuleEvidence {
        path: "leaf".into(),
        changed_exports: ["changed".to_owned()].into_iter().collect(),
        every_hunk_is_attributed: true,
        semantic_change: true,
        type_only_change: false,
        module_eval_changed: false,
    }]);

    let reachable = graph.symbol_reachability_from(["leaf".into()]);

    assert!(reachable.paths.contains("barrel"));
    assert!(reachable.paths.contains("changed-consumer"));
    assert!(!reachable.paths.contains("unchanged-consumer"));
    assert!(reachable.uncertainties.is_empty());
}

#[test]
fn diamond_export_star_propagates_symbols_from_both_changed_leaves() {
    let a = node("a", "foo", None);
    let b = node("b", "bar", None);
    let barrel = ModuleNode {
        path: "barrel".into(),
        language: "fixture".into(),
        declarations: vec![],
        references: vec![],
        imports: vec![
            ImportFact {
                specifier: "a".into(),
                span: SourceSpan { start: 0, end: 1 },
                kind: ImportKind::ReExport,
                type_only: false,
                requested_symbols: BTreeSet::new(),
                namespace_import: false,
                reexport_all: true,
                reexport_namespace: None,
                resolved_path: Some("a".into()),
                position: None,
                export_deps: None,
                member_reads: None,
            },
            ImportFact {
                specifier: "b".into(),
                span: SourceSpan { start: 2, end: 3 },
                kind: ImportKind::ReExport,
                type_only: false,
                requested_symbols: BTreeSet::new(),
                namespace_import: false,
                reexport_all: true,
                reexport_namespace: None,
                resolved_path: Some("b".into()),
                position: None,
                export_deps: None,
                member_reads: None,
            },
        ],
    };
    let bar_test = node("bar.test", "result", Some(("barrel", "bar")));
    let unrelated_test = node("unrelated.test", "result", Some(("barrel", "baz")));
    let graph = DependencyGraph::new(vec![a, b, barrel, bar_test, unrelated_test], vec![])
        .with_changed_module_evidence(vec![
            ChangedModuleEvidence {
                path: "a".into(),
                changed_exports: ["foo".to_owned()].into_iter().collect(),
                every_hunk_is_attributed: true,
                semantic_change: true,
                type_only_change: false,
                module_eval_changed: false,
            },
            ChangedModuleEvidence {
                path: "b".into(),
                changed_exports: ["bar".to_owned()].into_iter().collect(),
                every_hunk_is_attributed: true,
                semantic_change: true,
                type_only_change: false,
                module_eval_changed: false,
            },
        ]);

    let reachable = graph.symbol_reachability_from(["a".into(), "b".into()]);

    assert!(reachable.paths.contains("barrel"));
    assert!(reachable.paths.contains("bar.test"));
    assert!(!reachable.paths.contains("unrelated.test"));
    assert!(reachable.uncertainties.is_empty());
}

#[test]
fn mixed_export_star_and_named_import_still_propagates_own_exports() {
    let a = node("a", "foo", None);
    let b = node("b", "bar", None);
    let hybrid = ModuleNode {
        path: "hybrid".into(),
        language: "fixture".into(),
        declarations: vec![SymbolFact {
            name: "own".into(),
            span: SourceSpan { start: 0, end: 1 },
        }],
        references: vec![],
        imports: vec![
            ImportFact {
                specifier: "a".into(),
                span: SourceSpan { start: 0, end: 1 },
                kind: ImportKind::ReExport,
                type_only: false,
                requested_symbols: BTreeSet::new(),
                namespace_import: false,
                reexport_all: true,
                reexport_namespace: None,
                resolved_path: Some("a".into()),
                position: None,
                export_deps: None,
                member_reads: None,
            },
            ImportFact {
                specifier: "b".into(),
                span: SourceSpan { start: 2, end: 3 },
                kind: ImportKind::Static,
                type_only: false,
                requested_symbols: ["bar".to_owned()].into_iter().collect(),
                namespace_import: false,
                reexport_all: false,
                reexport_namespace: None,
                resolved_path: Some("b".into()),
                position: None,
                export_deps: None,
                member_reads: None,
            },
        ],
    };
    let own_test = node("own.test", "result", Some(("hybrid", "own")));
    let graph = DependencyGraph::new(vec![a, b, hybrid, own_test], vec![])
        .with_changed_module_evidence(vec![
            ChangedModuleEvidence {
                path: "a".into(),
                changed_exports: ["foo".to_owned()].into_iter().collect(),
                every_hunk_is_attributed: true,
                semantic_change: true,
                type_only_change: false,
                module_eval_changed: false,
            },
            ChangedModuleEvidence {
                path: "b".into(),
                changed_exports: ["bar".to_owned()].into_iter().collect(),
                every_hunk_is_attributed: true,
                semantic_change: true,
                type_only_change: false,
                module_eval_changed: false,
            },
        ]);

    let reachable = graph.symbol_reachability_from(["a".into(), "b".into()]);

    assert!(reachable.paths.contains("hybrid"));
    assert!(reachable.paths.contains("own.test"));
    assert!(reachable.uncertainties.is_empty());
}

#[test]
fn terminal_importer_without_exports_does_not_make_reachability_uncertain() {
    let mut terminal_test = ModuleNode {
        path: "leaf.test".into(),
        language: "fixture".into(),
        declarations: vec![],
        references: vec![],
        imports: vec![],
    };
    terminal_test.imports.push(ImportFact {
        specifier: "leaf".into(),
        span: SourceSpan { start: 0, end: 1 },
        kind: ImportKind::Static,
        type_only: false,
        requested_symbols: ["value".to_owned()].into_iter().collect(),
        namespace_import: false,
        reexport_all: false,
        reexport_namespace: None,
        resolved_path: Some("leaf".into()),
        position: None,
        export_deps: None,
        member_reads: None,
    });
    let graph = DependencyGraph::new(vec![node("leaf", "value", None), terminal_test], vec![])
        .with_changed_module_evidence(vec![ChangedModuleEvidence {
            path: "leaf".into(),
            changed_exports: ["value".to_owned()].into_iter().collect(),
            every_hunk_is_attributed: true,
            semantic_change: true,
            type_only_change: false,
            module_eval_changed: false,
        }]);

    let reachable = graph.symbol_reachability_from(["leaf".into()]);

    assert!(reachable.paths.contains("leaf.test"));
    assert!(reachable.uncertainties.is_empty());
}

#[test]
fn symbol_reachability_records_followed_edges() {
    let leaf = ModuleNode {
        path: "leaf".into(),
        language: "fixture".into(),
        declarations: vec![SymbolFact {
            name: "changed".into(),
            span: SourceSpan { start: 0, end: 1 },
        }],
        references: vec![],
        imports: vec![],
    };
    let mut importer = node("importer", "result", Some(("leaf", "changed")));
    importer.imports[0].position = Some(LineColumn {
        line: 4,
        column: 22,
    });
    let graph =
        DependencyGraph::new(vec![leaf, importer], vec![]).with_changed_module_evidence(vec![
            ChangedModuleEvidence {
                path: "leaf".into(),
                changed_exports: ["changed".to_owned()].into_iter().collect(),
                every_hunk_is_attributed: true,
                semantic_change: true,
                type_only_change: false,
                module_eval_changed: false,
            },
        ]);

    let reachable = graph.symbol_reachability_from(["leaf".into()]);

    assert_eq!(
        reachable.edges,
        vec![ReachedEdge {
            importer: "importer".into(),
            target: "leaf".into(),
            symbols: ["changed".to_owned()].into_iter().collect(),
            position: Some(LineColumn {
                line: 4,
                column: 22
            }),
        }]
    );
    assert_eq!(
        graph.changed_exports("leaf"),
        Some(["changed".to_owned()].into_iter().collect())
    );
    assert!(
        graph
            .reachability_from(["leaf".to_owned()])
            .edges
            .is_empty()
    );
}

#[test]
fn type_only_edge_uncertainty_carries_the_import_location() {
    let mut importer = node("importer", "result", Some(("leaf", "changed")));
    importer.imports[0].type_only = true;
    importer.imports[0].span = SourceSpan { start: 40, end: 52 };
    importer.imports[0].position = Some(LineColumn { line: 3, column: 9 });
    let leaf = ModuleNode {
        path: "leaf".into(),
        language: "fixture".into(),
        declarations: vec![SymbolFact {
            name: "changed".into(),
            span: SourceSpan { start: 0, end: 1 },
        }],
        references: vec![],
        imports: vec![],
    };
    let graph =
        DependencyGraph::new(vec![leaf, importer], vec![]).with_changed_module_evidence(vec![
            ChangedModuleEvidence {
                path: "leaf".into(),
                changed_exports: ["changed".to_owned()].into_iter().collect(),
                every_hunk_is_attributed: true,
                semantic_change: true,
                type_only_change: false,
                module_eval_changed: false,
            },
        ]);

    let reachable = graph.symbol_reachability_from(["leaf".into()]);
    let uncertainty = reachable
        .uncertainties
        .iter()
        .find(|uncertainty| uncertainty.code == "ambiguous-cross-file-import")
        .expect("a type-only edge must stay uncertain");

    assert_eq!(
        uncertainty.location,
        Some(SourceLocation {
            span: SourceSpan { start: 40, end: 52 },
            position: LineColumn { line: 3, column: 9 },
        })
    );
}

#[test]
fn a_graph_without_locations_still_deserializes() {
    let legacy = r#"{
  "strings": ["fixture", "leaf", "value"],
  "modules": [{ "path": 1, "language": 0, "declarations": [[2, { "start": 0, "end": 1 }]], "references": [], "start": 0, "count": 0 }],
  "imports": [],
  "reverse_offsets": [0, 0],
  "reverse_edges": [],
  "uncertainties": [{ "path": 1, "code": 2, "message": 0 }],
  "changes": []
}"#;

    let graph: DependencyGraph =
        serde_json::from_str(legacy).expect("a v2-shaped graph must still deserialize");

    assert!(graph.contains_path("leaf"));
    assert!(graph.has_uncertainty());
    let reachable = graph.symbol_reachability_from(["leaf".to_owned()]);
    assert!(
        reachable
            .uncertainties
            .iter()
            .all(|uncertainty| uncertainty.location.is_none())
    );
}

#[test]
fn module_eval_changed_propagates_runtime_edges_transitively_and_erases_import_type() {
    let leaf = node("leaf", "marker", None);
    let mid = node("mid", "computeTax", Some(("leaf", "computeTax")));
    let runtime_test = node("runtime.test", "t", Some(("mid", "computeTax")));
    let unrelated_test = node("unrelated.test", "u", None);
    let mut type_only_test = node("type-only.test", "ty", Some(("leaf", "LeafType")));
    type_only_test.imports[0].type_only = true;
    let mut cycle_a = node("cycle-a", "a", Some(("leaf", "other")));
    cycle_a.imports.push(ImportFact {
        specifier: "cycle-b".into(),
        span: SourceSpan { start: 2, end: 3 },
        kind: ImportKind::Static,
        type_only: false,
        requested_symbols: ["b".to_owned()].into_iter().collect(),
        namespace_import: false,
        reexport_all: false,
        reexport_namespace: None,
        resolved_path: Some("cycle-b".into()),
        position: None,
        export_deps: None,
        member_reads: None,
    });
    let cycle_b = node("cycle-b", "b", Some(("cycle-a", "a")));
    let graph = DependencyGraph::new(
        vec![
            leaf,
            mid,
            runtime_test,
            unrelated_test,
            type_only_test,
            cycle_a,
            cycle_b,
        ],
        vec![],
    )
    .with_changed_module_evidence(vec![ChangedModuleEvidence {
        path: "leaf".into(),
        changed_exports: ["marker".to_owned()].into_iter().collect(),
        every_hunk_is_attributed: true,
        semantic_change: true,
        type_only_change: false,
        module_eval_changed: true,
    }]);

    let round_tripped: DependencyGraph =
        serde_json::from_str(&serde_json::to_string(&graph).expect("serialize"))
            .expect("deserialize");
    assert!(round_tripped.module_eval_changed("leaf"));

    let runtime = round_tripped.symbol_reachability_runtime(["leaf".into()]);
    assert!(runtime.paths.contains("leaf"));
    assert!(runtime.paths.contains("mid"));
    assert!(runtime.paths.contains("runtime.test"));
    assert!(runtime.paths.contains("cycle-a"));
    assert!(runtime.paths.contains("cycle-b"));
    assert!(!runtime.paths.contains("type-only.test"));
    assert!(!runtime.paths.contains("unrelated.test"));
    assert!(runtime.uncertainties.is_empty());

    let typecheck = round_tripped.symbol_reachability_from(["leaf".into()]);
    assert!(typecheck.paths.contains("runtime.test"));
    assert!(
        typecheck
            .uncertainties
            .iter()
            .any(|u| { u.path == "type-only.test" && u.code == "ambiguous-cross-file-import" })
    );
}

fn node(path: &str, export: &str, dep: Option<(&str, &str)>) -> ModuleNode {
    ModuleNode {
        path: path.into(),
        language: "fixture".into(),
        declarations: vec![SymbolFact {
            name: export.into(),
            span: SourceSpan { start: 0, end: 1 },
        }],
        references: vec![],
        imports: dep
            .map(|(p, n)| {
                vec![ImportFact {
                    specifier: p.into(),
                    span: SourceSpan { start: 0, end: 1 },
                    kind: ImportKind::Static,
                    type_only: false,
                    requested_symbols: [n.to_owned()].into_iter().collect(),
                    namespace_import: false,
                    reexport_all: false,
                    reexport_namespace: None,
                    resolved_path: Some(p.into()),
                    position: None,
                    export_deps: None,
                    member_reads: None,
                }]
            })
            .unwrap_or_default(),
    }
}
