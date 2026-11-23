//! The plain facts this adapter copies out of Oxc. Every field is owned data: no arena
//! references, no Oxc IDs, and no resolver values survive past the analysis that produced them.

use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsWorkspaceFacts {
    pub modules: Vec<JsModuleFacts>,
    pub uncertainties: Vec<JsUncertainty>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsModuleFacts {
    pub path: String,
    pub language: JsLanguage,
    pub declarations: Vec<JsSymbolFact>,
    pub references: Vec<JsSymbolFact>,
    pub imports: Vec<JsImportFact>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsLanguage {
    JavaScript,
    TypeScript,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsSymbolFact {
    pub name: String,
    pub span: JsSpan,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsImportFact {
    pub specifier: String,
    pub span: JsSpan,
    pub kind: JsImportKind,
    pub type_only: bool,
    pub requested_symbols: BTreeSet<String>,
    pub namespace_import: bool,
    pub reexport_all: bool,
    pub reexport_namespace: Option<String>,
    pub resolved_path: Option<String>,
    pub position: Option<JsPosition>,
    pub export_deps: Option<BTreeMap<String, BTreeSet<String>>>,
    pub member_reads: Option<BTreeMap<String, BTreeSet<String>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsImportKind {
    StaticImport,
    ExportFrom,
    DynamicImport,
    CommonJsRequire,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JsSpan {
    pub start: u32,
    pub end: u32,
}

/// One-based line and character column of a byte offset in the analyzed source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JsPosition {
    pub line: u32,
    pub column: u32,
}

/// An uncertainty carries the syntax it came from whenever one file position explains it. File-
/// level failures (an unreadable directory, file, or source type) have no such position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsUncertainty {
    pub path: String,
    pub code: String,
    pub message: String,
    pub span: Option<JsSpan>,
    pub position: Option<JsPosition>,
}
