//! JavaScript and TypeScript fact extraction for Dads Testing.
//!
//! Oxc is intentionally contained in this adapter. Its arena-backed data is converted into plain
//! strings and byte spans before this crate returns, so consumers never retain Oxc IDs, lifetimes,
//! AST nodes, or resolver values.

mod changed_module_evidence;
mod commonjs;
mod diff_hunks;
mod erased_spans;
mod export_declarations;
mod facts;
mod file_discovery;
mod frontend;
mod graph_export;
mod import_declarations;
mod intra_file_deps;
mod intra_file_purity;
mod module_analysis;
mod module_statement_spans;
mod private_helper_attribution;
mod removed_paths;
mod spans;
mod specifier_resolution;
mod top_level_classification;
mod workspace;

#[cfg(test)]
mod tests;

pub use facts::{
    JsImportFact, JsImportKind, JsLanguage, JsModuleFacts, JsPosition, JsSpan, JsSymbolFact,
    JsUncertainty, JsWorkspaceFacts,
};
pub use frontend::{
    JavaScriptFrontend, analyze_request, analyze_workspace, analyze_workspace_graph,
};
