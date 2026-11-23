//! Sound private-helper hunk attribution for pure top-level JS/TS modules.
//!
//! Directly implements the algorithm formally verified in `proofs/dad-test/DadTest/PrivateHelper.lean`:
//! - Requires every top-level statement in the module to be side-effect-free (`collect_pure_top_level_decls`).
//! - Requires every non-whitespace byte of every changed hunk to fall inside a known pure top-level
//!   declaration span (exported or private).
//! - Computes the exact reverse intra-file def-use closure (`bfs_affected_exports`) from all touched
//!   declarations to the exported names that transitively observe them.
//! - Any impure top-level statement, parse/semantic failure, or unattributed byte returns `None`,
//!   preserving conservative widening (`impure_module_widens_conservatively`,
//!   `unattributed_hunk_widens_conservatively`).

use crate::diff_hunks::ByteRange;
use crate::intra_file_deps::{
    bfs_affected_exports, build_intra_file_graph, collect_bare_export_spans,
    collect_pure_top_level_decls, map_nodes_to_export_names,
};
use crate::intra_file_purity::DeclNode;
use oxc_allocator::Allocator;
use oxc_ast::ast::{Declaration, Statement};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::{GetSpan, SourceType, Span};
use std::collections::BTreeSet;
use std::path::Path;

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

    // Widen single-declaration statements to their statement span so hunks covering `const` or
    // `export` keywords still map cleanly to that declaration's `DeclNode`.
    let ownership_spans = statement_ownership_spans(&parsed.program, &decl_spans);

    let mut seeds = Vec::new();
    for range in changed_ranges {
        let Some(trimmed) = trim_whitespace_range(source, *range) else {
            continue;
        };
        let overlapping = ownership_spans
            .iter()
            .filter(|(span, _)| {
                (span.start as usize) < trimmed.end && trimmed.start < (span.end as usize)
            })
            .collect::<Vec<_>>();
        if overlapping.is_empty() {
            return None;
        }
        // Every non-whitespace byte in `trimmed` must be covered by a pure declaration span
        // (matching `allHunksInKnownDecls` in `PrivateHelper.lean`).
        if !range_fully_covered_by_decls(source, trimmed, &overlapping) {
            return None;
        }
        for (_, node) in overlapping {
            seeds.push(*node);
        }
    }

    Some(bfs_affected_exports(&graph, &exports_by_node, &seeds))
}

fn statement_ownership_spans(
    program: &oxc_ast::ast::Program<'_>,
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

fn range_fully_covered_by_decls(
    source: &str,
    range: ByteRange,
    overlapping: &[&(Span, DeclNode)],
) -> bool {
    let Some(bytes) = source.as_bytes().get(range.start..range.end) else {
        return false;
    };
    for (offset, byte) in bytes.iter().enumerate() {
        if byte.is_ascii_whitespace() {
            continue;
        }
        let pos = range.start + offset;
        if !overlapping
            .iter()
            .any(|(span, _)| (span.start as usize) <= pos && pos < (span.end as usize))
        {
            return false;
        }
    }
    true
}
