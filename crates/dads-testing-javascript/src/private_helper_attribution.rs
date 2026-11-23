//! Sound private-helper, import-line, and newly-added pure module attribution.
//!
//! Directly implements the algorithms formally verified in:
//! - `proofs/dad-test/DadTest/PrivateHelper.lean`
//! - `proofs/dad-test/DadTest/NamespaceAndImports.lean` (Part B, Theorems 4–7)
//!
//! Guarantees:
//! - Requires every top-level statement in the module to be side-effect-free (`collect_pure_top_level_decls`).
//! - Bare side-effect imports (`import "./polyfill"`) are NEVER included in attributed spans, so
//!   any hunk touching one returns `None` and widens conservatively (`side_effect_import_widens`).
//! - Bound import declarations (`import { a, b } from "./x"`) map touched specifiers (or all
//!   bindings on specifier/path edits) into the intra-file def-use graph, seeding ONLY exports that
//!   transitively reference the touched bindings (`import_line_edit_sound`).
//! - Newly-added pure modules (`is_pure_top_level_module`) attribute cleanly to their declared
//!   exports (`new_pure_module_sound`); impure newly-added modules widen (`new_impure_module_widens`).

use crate::diff_hunks::ByteRange;
use crate::intra_file_deps::{
    bfs_affected_exports, build_intra_file_graph, collect_bare_export_spans,
    collect_pure_top_level_decls, map_nodes_to_export_names,
};
use crate::intra_file_purity::{DeclNode, find_root_symbol};
use oxc_allocator::Allocator;
use oxc_ast::ast::{Declaration, ImportDeclarationSpecifier, Program, Statement};
use oxc_parser::Parser;
use oxc_semantic::{Semantic, SemanticBuilder};
use oxc_span::{GetSpan, SourceType, Span};
use std::collections::BTreeSet;
use std::path::Path;

/// Returns `true` iff `source` parses cleanly, has zero top-level side effects, and contains no
/// bare side-effect runtime imports (`import "./x"`). Matches `isPureTopLevel` in
/// `NamespaceAndImports.lean`.
pub(crate) fn is_pure_top_level_module(source: &str, path: &Path) -> bool {
    let Ok(source_type) = SourceType::from_path(path) else {
        return false;
    };
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if parsed.panicked || !parsed.diagnostics.is_empty() {
        return false;
    }
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .with_check_syntax_error(true)
        .build(&parsed.program);
    if !semantic.diagnostics.is_empty() {
        return false;
    }
    !has_bare_side_effect_import(&parsed.program)
        && collect_pure_top_level_decls(&parsed.program, &semantic.semantic).is_some()
}

pub(crate) fn attribute_pure_module_hunks(
    source: &str,
    path: &Path,
    changed_ranges: &[ByteRange],
) -> Option<BTreeSet<String>> {
    if changed_ranges.iter().all(|range| range.is_empty()) {
        return Some(BTreeSet::new());
    }
    let source_type = SourceType::from_path(path).ok()?;
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if parsed.panicked || !parsed.diagnostics.is_empty() {
        return None;
    }
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .with_check_syntax_error(true)
        .build(&parsed.program);
    if !semantic.diagnostics.is_empty() {
        return None;
    }
    let decl_spans = collect_pure_top_level_decls(&parsed.program, &semantic.semantic)?;
    let export_specifier_spans = collect_bare_export_spans(&parsed.program);
    let graph = build_intra_file_graph(&semantic.semantic, &decl_spans, &export_specifier_spans)?;
    let exports_by_node = map_nodes_to_export_names(&parsed.module_record, &semantic.semantic);

    let ownership_spans = statement_ownership_spans(&parsed.program, &decl_spans);
    let import_spans = bound_import_ownership_spans(&parsed.program, &semantic.semantic);

    let mut seeds = Vec::new();
    for range in changed_ranges {
        let Some(trimmed) = trim_whitespace_range(source, *range) else {
            continue;
        };
        let mut covering_spans: Vec<Span> = Vec::new();
        for (span, node) in &ownership_spans {
            if span_overlaps(*span, trimmed) {
                covering_spans.push(*span);
                seeds.push(*node);
            }
        }
        for imp in &import_spans {
            if span_overlaps(imp.statement_span, trimmed) {
                covering_spans.push(imp.statement_span);
                collect_touched_import_seeds(imp, trimmed, &mut seeds);
            }
        }
        if covering_spans.is_empty() || !range_fully_covered(source, trimmed, &covering_spans) {
            return None;
        }
    }

    Some(bfs_affected_exports(&graph, &exports_by_node, &seeds))
}

struct BoundImportSpan {
    statement_span: Span,
    specifiers: Vec<(Span, DeclNode)>,
}

fn has_bare_side_effect_import(program: &Program<'_>) -> bool {
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

fn bound_import_ownership_spans(
    program: &Program<'_>,
    semantic: &Semantic<'_>,
) -> Vec<BoundImportSpan> {
    let mut out = Vec::new();
    for stmt in &program.body {
        let Statement::ImportDeclaration(imp) = stmt else {
            continue;
        };
        if imp.import_kind.is_type() {
            out.push(BoundImportSpan {
                statement_span: imp.span,
                specifiers: Vec::new(),
            });
            continue;
        }
        let Some(specifiers) = imp.specifiers.as_ref() else {
            // Bare side-effect import (`import "./polyfill"`) is intentionally excluded so any
            // hunk overlapping it returns `None` (`side_effect_import_widens`).
            continue;
        };
        if specifiers.is_empty() {
            continue;
        }
        let mut nodes = Vec::new();
        let mut all_resolved = true;
        for spec in specifiers {
            match spec {
                ImportDeclarationSpecifier::ImportSpecifier(named) => {
                    if named.import_kind.is_type() {
                        continue;
                    }
                    if let Some(sym) =
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
                    if let Some(sym) =
                        find_root_symbol(semantic, ns.local.name.as_str(), ns.local.span)
                    {
                        nodes.push((ns.span, DeclNode::Symbol(sym)));
                    } else {
                        all_resolved = false;
                    }
                }
            }
        }
        if all_resolved {
            out.push(BoundImportSpan {
                statement_span: imp.span,
                specifiers: nodes,
            });
        }
    }
    out
}

fn collect_touched_import_seeds(
    imp: &BoundImportSpan,
    trimmed: ByteRange,
    seeds: &mut Vec<DeclNode>,
) {
    let mut matched_specifiers = Vec::new();
    let mut covered_by_specifiers = false;
    for (spec_span, node) in &imp.specifiers {
        if span_overlaps(*spec_span, trimmed) {
            matched_specifiers.push(*node);
            if (spec_span.start as usize) <= trimmed.start
                && trimmed.end <= (spec_span.end as usize)
            {
                covered_by_specifiers = true;
            }
        }
    }
    if covered_by_specifiers && !matched_specifiers.is_empty() {
        seeds.extend(matched_specifiers);
    } else {
        // Edit touched the module specifier (`from "./x"`) or multiple/surrounding tokens:
        // conservatively seed every runtime binding of this import statement.
        seeds.extend(imp.specifiers.iter().map(|(_, node)| *node));
    }
}

fn span_overlaps(span: Span, range: ByteRange) -> bool {
    (span.start as usize) < range.end && range.start < (span.end as usize)
}

fn statement_ownership_spans(
    program: &Program<'_>,
    decl_spans: &[(Span, DeclNode)],
) -> Vec<(Span, DeclNode)> {
    let mut result = Vec::with_capacity(decl_spans.len());
    for (decl_span, node) in decl_spans {
        let widened = program
            .body
            .iter()
            .find_map(|stmt| single_owner_stmt_span(stmt, *decl_span))
            .unwrap_or(*decl_span);
        result.push((widened, *node));
    }
    result
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
        | Statement::TSInterfaceDeclaration(_) => Some(span),
        _ => None,
    }
}

fn trim_whitespace_range(source: &str, range: ByteRange) -> Option<ByteRange> {
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

fn range_fully_covered(source: &str, range: ByteRange, spans: &[Span]) -> bool {
    let Some(bytes) = source.as_bytes().get(range.start..range.end) else {
        return false;
    };
    for (offset, byte) in bytes.iter().enumerate() {
        if byte.is_ascii_whitespace() {
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
