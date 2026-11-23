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
        resolved_path: Some("leaf".into()),
        position: None,
        export_deps: None,
    });
    let graph = DependencyGraph::new(vec![node("leaf", "value", None), importer], vec![])
        .with_changed_module_evidence(vec![ChangedModuleEvidence {
            path: "leaf".into(),
            changed_exports: ["value".to_owned()].into_iter().collect(),
            every_hunk_is_attributed: true,
            semantic_change: true,
            type_only_change: false,
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
            resolved_path: Some("leaf".into()),
            position: None,
            export_deps: None,
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
                resolved_path: Some("a".into()),
                position: None,
                export_deps: None,
            },
            ImportFact {
                specifier: "b".into(),
                span: SourceSpan { start: 2, end: 3 },
                kind: ImportKind::ReExport,
                type_only: false,
                requested_symbols: BTreeSet::new(),
                namespace_import: false,
                reexport_all: true,
                resolved_path: Some("b".into()),
                position: None,
                export_deps: None,
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
            },
            ChangedModuleEvidence {
                path: "b".into(),
                changed_exports: ["bar".to_owned()].into_iter().collect(),
                every_hunk_is_attributed: true,
                semantic_change: true,
                type_only_change: false,
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
                resolved_path: Some("a".into()),
                position: None,
                export_deps: None,
            },
            ImportFact {
                specifier: "b".into(),
                span: SourceSpan { start: 2, end: 3 },
                kind: ImportKind::Static,
                type_only: false,
                requested_symbols: ["bar".to_owned()].into_iter().collect(),
                namespace_import: false,
                reexport_all: false,
                resolved_path: Some("b".into()),
                position: None,
                export_deps: None,
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
            },
            ChangedModuleEvidence {
                path: "b".into(),
                changed_exports: ["bar".to_owned()].into_iter().collect(),
                every_hunk_is_attributed: true,
                semantic_change: true,
                type_only_change: false,
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
        resolved_path: Some("leaf".into()),
        position: None,
        export_deps: None,
    });
    let graph = DependencyGraph::new(vec![node("leaf", "value", None), terminal_test], vec![])
        .with_changed_module_evidence(vec![ChangedModuleEvidence {
            path: "leaf".into(),
            changed_exports: ["value".to_owned()].into_iter().collect(),
            every_hunk_is_attributed: true,
            semantic_change: true,
            type_only_change: false,
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
                    resolved_path: Some(p.into()),
                    position: None,
                    export_deps: None,
                }]
            })
            .unwrap_or_default(),
    }
}
