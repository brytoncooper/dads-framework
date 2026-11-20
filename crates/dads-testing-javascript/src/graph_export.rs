//! The one place adapter facts become the core-owned dependency graph. Every value is copied, so
//! the returned graph shares nothing with the Oxc arena that produced it.

use crate::facts::{JsImportKind, JsLanguage, JsPosition, JsWorkspaceFacts};
use dads_testing_core::graph::{
    DependencyGraph, GraphUncertainty, GraphUncertaintyScope, ImportFact, ImportKind, LineColumn,
    ModuleNode, SourceLocation, SourceSpan, SymbolFact,
};

pub(crate) fn copy_to_core_graph(facts: JsWorkspaceFacts) -> DependencyGraph {
    let modules = facts
        .modules
        .into_iter()
        .map(|module| ModuleNode {
            path: module.path,
            language: match module.language {
                JsLanguage::JavaScript => "javascript".to_owned(),
                JsLanguage::TypeScript => "typescript".to_owned(),
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
                        JsImportKind::CommonJsRequire => ImportKind::Runtime,
                    },
                    type_only: import.type_only,
                    requested_symbols: import.requested_symbols,
                    namespace_import: import.namespace_import,
                    reexport_all: import.reexport_all,
                    resolved_path: import.resolved_path,
                    position: import.position.map(core_position),
                })
                .collect(),
        })
        .collect();
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
    DependencyGraph::new(modules, uncertainties)
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
