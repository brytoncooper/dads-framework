//! The one place adapter facts become the core-owned dependency graph. Every value is copied, so
//! the returned graph shares nothing with the Oxc arena that produced it.

use crate::asset_evidence::{referenced_asset_paths, synthetic_asset_node};
use crate::facts::{JsImportKind, JsLanguage, JsPosition, JsWorkspaceFacts};
use dads_testing_core::graph::{
    DependencyGraph, GraphUncertainty, GraphUncertaintyScope, ImportFact, ImportKind, LineColumn,
    ModuleNode, SourceLocation, SourceSpan, SymbolFact,
};

pub(crate) fn copy_to_core_graph(facts: JsWorkspaceFacts) -> DependencyGraph {
    let (modules, uncertainties) = convert_workspace_facts(facts, true);
    DependencyGraph::new(modules, uncertainties)
}

/// Converts incrementally re-analyzed modules directly into core `ModuleNode`s and
/// `GraphUncertainty` values without round-tripping through a partial `DependencyGraph`, so
/// `ImportFact::resolved_path` targets pointing at unchanged modules are preserved for
/// `DependencyGraph::patch_modules`.
pub(crate) fn copy_to_core_patch_parts(
    facts: JsWorkspaceFacts,
) -> (Vec<ModuleNode>, Vec<GraphUncertainty>) {
    convert_workspace_facts(facts, false)
}

fn convert_workspace_facts(
    facts: JsWorkspaceFacts,
    include_synthetic_assets: bool,
) -> (Vec<ModuleNode>, Vec<GraphUncertainty>) {
    let synthetic_assets = if include_synthetic_assets {
        referenced_asset_paths(&facts.modules)
    } else {
        std::collections::BTreeSet::new()
    };
    let mut modules: Vec<ModuleNode> = facts
        .modules
        .into_iter()
        .map(|module| ModuleNode {
            path: module.path,
            language: match module.language {
                JsLanguage::JavaScript => "javascript".to_owned(),
                JsLanguage::TypeScript => "typescript".to_owned(),
                JsLanguage::Asset => "asset".to_owned(),
            },
            declarations: module
                .declarations
                .into_iter()
                .map(|symbol| SymbolFact {
                    name: symbol.name,
                    span: SourceSpan {
                        start: symbol.span.start,
                        end: symbol.span.end,
                    },
                })
                .collect(),
            references: module
                .references
                .into_iter()
                .map(|symbol| SymbolFact {
                    name: symbol.name,
                    span: SourceSpan {
                        start: symbol.span.start,
                        end: symbol.span.end,
                    },
                })
                .collect(),
            imports: module
                .imports
                .into_iter()
                .map(|import| ImportFact {
                    specifier: import.specifier,
                    span: SourceSpan {
                        start: import.span.start,
                        end: import.span.end,
                    },
                    kind: match import.kind {
                        JsImportKind::StaticImport => ImportKind::Static,
                        JsImportKind::ExportFrom => ImportKind::ReExport,
                        JsImportKind::DynamicImport => ImportKind::Dynamic,
                        JsImportKind::CommonJsRequire | JsImportKind::Asset => ImportKind::Runtime,
                        JsImportKind::FileRead => ImportKind::FileRead,
                    },
                    type_only: import.type_only,
                    requested_symbols: import.requested_symbols,
                    namespace_import: import.namespace_import,
                    reexport_all: import.reexport_all,
                    reexport_namespace: import.reexport_namespace,
                    resolved_path: import.resolved_path,
                    position: import.position.map(core_position),
                    export_deps: import.export_deps,
                    member_reads: import.member_reads,
                })
                .collect(),
        })
        .collect();
    for asset_path in synthetic_assets {
        modules.push(synthetic_asset_node(asset_path));
    }
    let uncertainties = facts
        .uncertainties
        .into_iter()
        .map(|uncertainty| GraphUncertainty {
            path: uncertainty.path,
            scope: graph_uncertainty_scope(&uncertainty.code),
            code: uncertainty.code,
            message: uncertainty.message,
            location: uncertainty
                .span
                .zip(uncertainty.position)
                .map(|(span, position)| SourceLocation {
                    span: SourceSpan {
                        start: span.start,
                        end: span.end,
                    },
                    position: core_position(position),
                }),
        })
        .collect();
    (modules, uncertainties)
}

fn core_position(position: JsPosition) -> LineColumn {
    LineColumn {
        line: position.line,
        column: position.column,
    }
}

fn graph_uncertainty_scope(code: &str) -> GraphUncertaintyScope {
    if code == "nonliteral-dynamic-import" {
        GraphUncertaintyScope::WholeWorkspace
    } else {
        GraphUncertaintyScope::ReachedModule
    }
}
