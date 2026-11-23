//! The public facts a language frontend hands the core, and the reachability answer it gets back.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceSpan {
    pub start: u32,
    pub end: u32,
}
/// One-based human position of a byte offset. Columns count characters after the last newline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineColumn {
    pub line: u32,
    pub column: u32,
}
/// A byte span paired with the human position of its start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceLocation {
    pub span: SourceSpan,
    pub position: LineColumn,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SymbolFact {
    pub name: String,
    pub span: SourceSpan,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportFact {
    pub specifier: String,
    pub span: SourceSpan,
    pub kind: ImportKind,
    pub type_only: bool,
    pub requested_symbols: BTreeSet<String>,
    pub namespace_import: bool,
    #[serde(default)]
    pub reexport_all: bool,
    pub resolved_path: Option<String>,
    #[serde(default)]
    pub position: Option<LineColumn>,
    /// Optional intra-file def-use map from imported symbol name to the subset of the importer's
    /// own export names that transitively depend on it. `None` falls back conservatively to all
    /// own exports of the importer.
    #[serde(default)]
    pub export_deps: Option<BTreeMap<String, BTreeSet<String>>>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ImportKind {
    Static,
    ReExport,
    Dynamic,
    Runtime,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModuleNode {
    pub path: String,
    pub language: String,
    pub declarations: Vec<SymbolFact>,
    pub references: Vec<SymbolFact>,
    pub imports: Vec<ImportFact>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphUncertainty {
    pub path: String,
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub scope: GraphUncertaintyScope,
    #[serde(default)]
    pub location: Option<SourceLocation>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum GraphUncertaintyScope {
    #[default]
    ReachedModule,
    WholeWorkspace,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangedModuleEvidence {
    pub path: String,
    pub changed_exports: BTreeSet<String>,
    pub every_hunk_is_attributed: bool,
    #[serde(default = "default_semantic_change")]
    pub semantic_change: bool,
    #[serde(default)]
    pub type_only_change: bool,
}

fn default_semantic_change() -> bool {
    true
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reachability {
    pub paths: BTreeSet<String>,
    pub uncertainties: Vec<GraphUncertainty>,
    pub edges: Vec<ReachedEdge>,
}
/// One followed reachability edge: the importer that a changed target reached, and the symbols
/// that carried the reach. Callers use this to explain a selection at its import site.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReachedEdge {
    pub importer: String,
    pub target: String,
    pub symbols: BTreeSet<String>,
    pub position: Option<LineColumn>,
}
