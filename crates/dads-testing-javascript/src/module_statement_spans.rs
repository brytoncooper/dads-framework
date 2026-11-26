//! Top-level import, export, and statement ownership span extraction for sound hunk attribution.

use crate::diff_hunks::ByteRange;
use crate::intra_file_deps::find_root_symbol_by_name;
use crate::intra_file_purity::{DeclNode, find_root_symbol};
use oxc_ast::ast::{Declaration, ImportDeclarationSpecifier, Program, Statement};
use oxc_semantic::Semantic;
use oxc_span::{GetSpan, Span};

pub(crate) struct BoundImportSpan {
    pub(crate) statement_span: Span,
    pub(crate) source_span: Span,
    pub(crate) is_type_only: bool,
    pub(crate) all_resolved: bool,
    pub(crate) specifiers: Vec<(Span, DeclNode)>,
    pub(crate) type_specifier_spans: Vec<Span>,
}

pub(crate) struct NamedExportSpan {
    pub(crate) statement_span: Span,
    pub(crate) is_type_only: bool,
    pub(crate) all_resolved: bool,
    pub(crate) specifiers: Vec<(Span, String, DeclNode)>,
    pub(crate) type_specifier_spans: Vec<Span>,
}

pub(crate) struct ReexportFromSpan {
    pub(crate) statement_span: Span,
    pub(crate) source_span: Span,
    pub(crate) is_type_only: bool,
    pub(crate) specifiers: Vec<(Span, String)>,
    pub(crate) type_specifier_spans: Vec<Span>,
}

pub(crate) fn has_bare_side_effect_import(program: &Program<'_>) -> bool {
    program.body.iter().any(|stmt| match stmt {
        Statement::ImportDeclaration(imp) => {
            !imp.import_kind.is_type()
                && imp
                    .specifiers
                    .as_ref()
                    .is_none_or(|specifiers| specifiers.is_empty())
        }
        _ => false,
    })
}

pub(crate) fn collect_runtime_import_specifiers(program: &Program<'_>) -> Vec<String> {
    program
        .body
        .iter()
        .filter_map(|stmt| match stmt {
            Statement::ImportDeclaration(imp) if !imp.import_kind.is_type() => {
                Some(imp.source.value.to_string())
            }
            Statement::ExportFromDeclaration(exp) if !exp.export_kind.is_type() => {
                Some(exp.source.value.to_string())
            }
            Statement::ExportAllDeclaration(exp) if !exp.export_kind.is_type() => {
                Some(exp.source.value.to_string())
            }
            _ => None,
        })
        .collect()
}

pub(crate) fn collect_export_all_spans(program: &Program<'_>) -> Vec<Span> {
    program
        .body
        .iter()
        .filter_map(|stmt| match stmt {
            Statement::ExportAllDeclaration(exp) if !exp.export_kind.is_type() => Some(exp.span),
            _ => None,
        })
        .collect()
}

pub(crate) fn bound_import_ownership_spans(
    program: &Program<'_>,
    semantic: &Semantic<'_>,
    include_type_only: bool,
) -> Vec<BoundImportSpan> {
    let mut out = Vec::new();
    for stmt in &program.body {
        let Statement::ImportDeclaration(imp) = stmt else {
            continue;
        };
        if imp.import_kind.is_type() && !include_type_only {
            out.push(BoundImportSpan {
                statement_span: imp.span,
                source_span: imp.source.span,
                is_type_only: true,
                all_resolved: true,
                specifiers: Vec::new(),
                type_specifier_spans: Vec::new(),
            });
            continue;
        }
        let Some(specifiers) = imp.specifiers.as_ref().filter(|specs| !specs.is_empty()) else {
            continue;
        };
        let (nodes, type_spans, all_resolved) =
            resolve_import_specifiers(specifiers, semantic, include_type_only);
        out.push(BoundImportSpan {
            statement_span: imp.span,
            source_span: imp.source.span,
            is_type_only: imp.import_kind.is_type() && !include_type_only,
            all_resolved,
            specifiers: nodes,
            type_specifier_spans: type_spans,
        });
    }
    out
}

fn resolve_import_specifiers(
    specifiers: &[ImportDeclarationSpecifier<'_>],
    semantic: &Semantic<'_>,
    include_type_only: bool,
) -> (Vec<(Span, DeclNode)>, Vec<Span>, bool) {
    let mut nodes = Vec::new();
    let mut type_spans = Vec::new();
    let mut all_resolved = true;
    for spec in specifiers {
        match spec {
            ImportDeclarationSpecifier::ImportSpecifier(named) => {
                if named.import_kind.is_type() && !include_type_only {
                    type_spans.push(named.span);
                } else if let Some(sym) =
                    find_root_symbol(semantic, named.local.name.as_str(), named.local.span)
                {
                    nodes.push((named.span, DeclNode::Symbol(sym)));
                } else {
                    all_resolved = false;
                }
            }
            ImportDeclarationSpecifier::ImportDefaultSpecifier(default_spec) => {
                if let Some(sym) = find_root_symbol(
                    semantic,
                    default_spec.local.name.as_str(),
                    default_spec.local.span,
                ) {
                    nodes.push((default_spec.span, DeclNode::Symbol(sym)));
                } else {
                    all_resolved = false;
                }
            }
            ImportDeclarationSpecifier::ImportNamespaceSpecifier(ns) => {
                if let Some(sym) = find_root_symbol(semantic, ns.local.name.as_str(), ns.local.span)
                {
                    nodes.push((ns.span, DeclNode::Symbol(sym)));
                } else {
                    all_resolved = false;
                }
            }
        }
    }
    (nodes, type_spans, all_resolved)
}

pub(crate) fn named_export_ownership_spans(
    program: &Program<'_>,
    semantic: &Semantic<'_>,
    include_type_only: bool,
) -> Vec<NamedExportSpan> {
    let mut out = Vec::new();
    for stmt in &program.body {
        let Statement::ExportNamedDeclaration(exp) = stmt else {
            continue;
        };
        if exp.export_kind.is_type() && !include_type_only {
            out.push(NamedExportSpan {
                statement_span: exp.span,
                is_type_only: true,
                all_resolved: true,
                specifiers: Vec::new(),
                type_specifier_spans: Vec::new(),
            });
            continue;
        }
        let mut specifiers = Vec::new();
        let mut type_spans = Vec::new();
        let mut all_resolved = true;
        for spec in &exp.specifiers {
            if spec.export_kind.is_type() && !include_type_only {
                type_spans.push(spec.span);
            } else if let Some(sym) = find_root_symbol_by_name(semantic, spec.local.name().as_str())
            {
                specifiers.push((
                    spec.span,
                    spec.exported.name().as_str().to_owned(),
                    DeclNode::Symbol(sym),
                ));
            } else {
                all_resolved = false;
            }
        }
        out.push(NamedExportSpan {
            statement_span: exp.span,
            is_type_only: exp.export_kind.is_type() && !include_type_only,
            all_resolved,
            specifiers,
            type_specifier_spans: type_spans,
        });
    }
    out
}

pub(crate) fn reexport_from_ownership_spans(
    program: &Program<'_>,
    include_type_only: bool,
) -> Vec<ReexportFromSpan> {
    program
        .body
        .iter()
        .filter_map(|stmt| {
            let Statement::ExportFromDeclaration(exp) = stmt else {
                return None;
            };
            let mut specifiers = Vec::new();
            let mut type_spans = Vec::new();
            if include_type_only || !exp.export_kind.is_type() {
                for spec in &exp.specifiers {
                    if spec.export_kind.is_type() && !include_type_only {
                        type_spans.push(spec.span);
                    } else {
                        specifiers.push((spec.span, spec.exported.name().as_str().to_owned()));
                    }
                }
            }
            Some(ReexportFromSpan {
                statement_span: exp.span,
                source_span: exp.source.span,
                is_type_only: exp.export_kind.is_type() && !include_type_only,
                specifiers,
                type_specifier_spans: type_spans,
            })
        })
        .collect()
}

pub(crate) fn statement_ownership_spans(
    program: &Program<'_>,
    decl_spans: &[(Span, DeclNode)],
) -> Vec<(Span, DeclNode)> {
    decl_spans
        .iter()
        .map(|(decl_span, node)| {
            let widened = program
                .body
                .iter()
                .find_map(|stmt| single_owner_stmt_span(stmt, *decl_span))
                .unwrap_or(*decl_span);
            (widened, *node)
        })
        .collect()
}

fn single_owner_stmt_span(stmt: &Statement<'_>, decl_span: Span) -> Option<Span> {
    let span = stmt.span();
    if span.start > decl_span.start || decl_span.end > span.end {
        return None;
    }
    match stmt {
        Statement::ExportDeclaration(export) => match &export.declaration {
            Declaration::VariableDeclaration(var_decl) if var_decl.declarations.len() != 1 => None,
            _ => Some(span),
        },
        Statement::VariableDeclaration(var_decl) if var_decl.declarations.len() == 1 => Some(span),
        Statement::FunctionDeclaration(_)
        | Statement::ClassDeclaration(_)
        | Statement::TSTypeAliasDeclaration(_)
        | Statement::TSInterfaceDeclaration(_)
        | Statement::TSEnumDeclaration(_) => Some(span),
        _ => None,
    }
}

pub(crate) fn span_overlaps(span: Span, range: ByteRange) -> bool {
    (span.start as usize) < range.end && range.start < (span.end as usize)
}

pub(crate) fn span_contains_range(span: Span, range: ByteRange) -> bool {
    (span.start as usize) <= range.start && range.end <= (span.end as usize)
}

pub(crate) fn trim_whitespace_range(source: &str, range: ByteRange) -> Option<ByteRange> {
    if range.is_empty() {
        return None;
    }
    let slice = source.get(range.start..range.end)?;
    let trimmed_start = slice.len() - slice.trim_start().len();
    let trimmed_end = slice.trim_end().len();
    if trimmed_start >= trimmed_end {
        return None;
    }
    Some(ByteRange {
        start: range.start + trimmed_start,
        end: range.start + trimmed_end,
    })
}

pub(crate) fn range_covered_with(
    source: &str,
    range: ByteRange,
    spans: &[Span],
    ignore_commas: bool,
) -> bool {
    let Some(bytes) = source.as_bytes().get(range.start..range.end) else {
        return false;
    };
    for (offset, byte) in bytes.iter().enumerate() {
        if byte.is_ascii_whitespace() || (ignore_commas && *byte == b',') {
            continue;
        }
        let pos = range.start + offset;
        if !spans
            .iter()
            .any(|span| (span.start as usize) <= pos && pos < (span.end as usize))
        {
            return false;
        }
    }
    true
}
