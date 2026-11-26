//! Sound per-declaration, private-helper, import-line, and module-evaluation attribution.
//!
//! Directly implements the algorithms formally verified in:
//! - `proofs/dad-test/DadTest/PrivateHelper.lean` (including per-node `EffectModuleIR`)
//! - `proofs/dad-test/DadTest/NamespaceAndImports.lean` (Part B, Theorems 4–7)

use crate::diff_hunks::ByteRange;
use crate::intra_file_deps::{
    bfs_reachable_nodes, build_intra_file_graph, collect_bare_export_spans,
    collect_pure_top_level_decls, map_nodes_to_export_names,
};
use crate::intra_file_purity::{DeclNode, PurityContext};
use crate::module_statement_spans::{
    BoundImportSpan, NamedExportSpan, ReexportFromSpan, bound_import_ownership_spans,
    collect_export_all_spans, collect_runtime_import_specifiers, has_bare_side_effect_import,
    named_export_ownership_spans, range_covered_with, reexport_from_ownership_spans,
    span_contains_range, span_overlaps, statement_ownership_spans, trim_whitespace_range,
};
use crate::top_level_classification::classify_top_level_statements;
use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::{SourceType, Span};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub(crate) struct ModuleHunkAttribution {
    pub(crate) changed_exports: BTreeSet<String>,
    pub(crate) module_eval_changed: bool,
}

/// Returns `true` iff `source` parses cleanly, has zero top-level side effects (respecting
/// `/*#__PURE__*/`, unshadowed pure built-ins, and `pure_factories`), and contains no bare
/// side-effect runtime imports (`import "./x"`).
pub(crate) fn is_pure_top_level_module(
    source: &str,
    path: &Path,
    pure_factories: &[String],
) -> bool {
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
        && collect_pure_top_level_decls(&parsed.program, &semantic.semantic, pure_factories)
            .is_some()
}

/// Soundly attributes all non-erased old/new diff ranges for a tracked module across BOTH
/// baseline and current ASTs, computing both `changed_exports` and `module_eval_changed`.
/// Returns `None` on parse/semantic failure, `export *` edits, or uncovered bytes (fail-closed).
pub(crate) fn attribute_module_hunks_with_eval(
    baseline_source: Option<&str>,
    current_source: &str,
    path: &Path,
    (old_ranges, new_ranges): (&[ByteRange], &[ByteRange]),
    pure_factories: &[String],
    include_type_only: bool,
) -> Option<ModuleHunkAttribution> {
    let current = analyze_side_hunks(
        current_source,
        path,
        new_ranges,
        pure_factories,
        include_type_only,
    )?;
    let mut changed_exports = current.changed_exports;
    let mut module_eval_changed = current.module_eval_changed;
    if let Some(baseline) = baseline_source {
        let old = analyze_side_hunks(
            baseline,
            path,
            old_ranges,
            pure_factories,
            include_type_only,
        )?;
        changed_exports.extend(old.changed_exports);
        module_eval_changed |= old.module_eval_changed;
        if old.runtime_import_specifiers != current.runtime_import_specifiers {
            module_eval_changed = true;
        }
    }
    Some(ModuleHunkAttribution {
        changed_exports,
        module_eval_changed,
    })
}

struct SideAttribution {
    changed_exports: BTreeSet<String>,
    module_eval_changed: bool,
    runtime_import_specifiers: Vec<String>,
}

struct SideContext {
    graph: BTreeMap<DeclNode, BTreeSet<DeclNode>>,
    effectful_nodes: BTreeSet<DeclNode>,
    exports_by_node: BTreeMap<DeclNode, BTreeSet<String>>,
    ownership_spans: Vec<(Span, DeclNode)>,
    bound_imports: Vec<BoundImportSpan>,
    named_exports: Vec<NamedExportSpan>,
    reexport_froms: Vec<ReexportFromSpan>,
    export_all_spans: Vec<Span>,
    comment_spans: Vec<Span>,
}

struct TouchAccumulator {
    seeds: Vec<DeclNode>,
    changed_exports: BTreeSet<String>,
    module_eval_changed: bool,
}

fn analyze_side_hunks(
    source: &str,
    path: &Path,
    changed_ranges: &[ByteRange],
    pure_factories: &[String],
    include_type_only: bool,
) -> Option<SideAttribution> {
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
    let runtime_import_specifiers = collect_runtime_import_specifiers(&parsed.program);
    if changed_ranges.iter().all(|range| range.is_empty()) {
        return Some(SideAttribution {
            changed_exports: BTreeSet::new(),
            module_eval_changed: false,
            runtime_import_specifiers,
        });
    }
    let ctx = PurityContext {
        semantic: &semantic.semantic,
        pure_factories,
    };
    let classified = classify_top_level_statements(&parsed.program, &ctx);
    let export_specifier_spans = collect_bare_export_spans(&parsed.program);
    let graph = build_intra_file_graph(
        &semantic.semantic,
        &classified.decl_spans,
        &export_specifier_spans,
    )?;
    let side = SideContext {
        graph,
        effectful_nodes: classified.effectful_nodes,
        exports_by_node: map_nodes_to_export_names(&parsed.module_record, &semantic.semantic),
        ownership_spans: statement_ownership_spans(&parsed.program, &classified.decl_spans),
        bound_imports: bound_import_ownership_spans(
            &parsed.program,
            &semantic.semantic,
            include_type_only,
        ),
        named_exports: named_export_ownership_spans(
            &parsed.program,
            &semantic.semantic,
            include_type_only,
        ),
        reexport_froms: reexport_from_ownership_spans(&parsed.program, include_type_only),
        export_all_spans: collect_export_all_spans(&parsed.program),
        comment_spans: parsed.program.comments.iter().map(|c| c.span).collect(),
    };
    attribute_ranges_against_side(source, changed_ranges, &side, runtime_import_specifiers)
}

fn attribute_ranges_against_side(
    source: &str,
    changed_ranges: &[ByteRange],
    side: &SideContext,
    runtime_import_specifiers: Vec<String>,
) -> Option<SideAttribution> {
    let mut acc = TouchAccumulator {
        seeds: Vec::new(),
        changed_exports: BTreeSet::new(),
        module_eval_changed: false,
    };
    for range in changed_ranges {
        if range.is_empty() {
            continue;
        }
        let Some(trimmed) = trim_whitespace_range(source, *range) else {
            attribute_internal_whitespace(*range, side, &mut acc)?;
            continue;
        };
        attribute_trimmed_range(source, trimmed, side, &mut acc)?;
    }
    for node in bfs_reachable_nodes(&side.graph, &acc.seeds) {
        if side.effectful_nodes.contains(&node) {
            acc.module_eval_changed = true;
        }
        if let Some(names) = side.exports_by_node.get(&node) {
            acc.changed_exports.extend(names.iter().cloned());
        }
    }
    Some(SideAttribution {
        changed_exports: acc.changed_exports,
        module_eval_changed: acc.module_eval_changed,
        runtime_import_specifiers,
    })
}

fn attribute_trimmed_range(
    source: &str,
    trimmed: ByteRange,
    side: &SideContext,
    acc: &mut TouchAccumulator,
) -> Option<()> {
    if side
        .export_all_spans
        .iter()
        .any(|span| span_overlaps(*span, trimmed))
    {
        return None;
    }
    let mut covering_spans = Vec::new();
    for (span, node) in &side.ownership_spans {
        if span_overlaps(*span, trimmed) {
            covering_spans.push(*span);
            acc.seeds.push(*node);
        }
    }
    for imp in &side.bound_imports {
        if span_overlaps(imp.statement_span, trimmed) {
            covering_spans.push(imp.statement_span);
            attribute_bound_import_touch(source, imp, trimmed, side, acc)?;
        }
    }
    for exp in &side.named_exports {
        if span_overlaps(exp.statement_span, trimmed) {
            covering_spans.push(exp.statement_span);
            attribute_named_export_touch(source, exp, trimmed, acc)?;
        }
    }
    for reexp in &side.reexport_froms {
        if span_overlaps(reexp.statement_span, trimmed) {
            covering_spans.push(reexp.statement_span);
            attribute_reexport_from_touch(source, reexp, trimmed, acc);
        }
    }
    for span in &side.comment_spans {
        if span_overlaps(*span, trimmed) {
            covering_spans.push(*span);
        }
    }
    if covering_spans.is_empty() || !range_covered_with(source, trimmed, &covering_spans, false) {
        return None;
    }
    Some(())
}

fn attribute_internal_whitespace(
    range: ByteRange,
    side: &SideContext,
    acc: &mut TouchAccumulator,
) -> Option<()> {
    if side
        .export_all_spans
        .iter()
        .any(|span| span_contains_range(*span, range))
    {
        return None;
    }
    for (span, node) in &side.ownership_spans {
        if span_contains_range(*span, range) {
            acc.seeds.push(*node);
        }
    }
    for imp in &side.bound_imports {
        if !imp.is_type_only && span_contains_range(imp.statement_span, range) {
            if !imp.all_resolved {
                return None;
            }
            acc.seeds
                .extend(imp.specifiers.iter().map(|(_, node)| *node));
        }
    }
    for exp in &side.named_exports {
        if !exp.is_type_only && span_contains_range(exp.statement_span, range) {
            if !exp.all_resolved {
                return None;
            }
            for (_, name, node) in &exp.specifiers {
                acc.changed_exports.insert(name.clone());
                acc.seeds.push(*node);
            }
        }
    }
    for reexp in &side.reexport_froms {
        if !reexp.is_type_only && span_contains_range(reexp.statement_span, range) {
            for (_, name) in &reexp.specifiers {
                acc.changed_exports.insert(name.clone());
            }
            if span_contains_range(reexp.source_span, range) {
                acc.module_eval_changed = true;
            }
        }
    }
    Some(())
}

fn attribute_bound_import_touch(
    source: &str,
    imp: &BoundImportSpan,
    trimmed: ByteRange,
    side: &SideContext,
    acc: &mut TouchAccumulator,
) -> Option<()> {
    if imp.is_type_only {
        return Some(());
    }
    if !imp.all_resolved {
        return None;
    }
    let all_spec_spans = imp
        .specifiers
        .iter()
        .map(|(span, _)| *span)
        .chain(imp.type_specifier_spans.iter().copied())
        .collect::<Vec<_>>();
    let specifier_only = !span_overlaps(imp.source_span, trimmed)
        && !all_spec_spans.is_empty()
        && range_covered_with(source, trimmed, &all_spec_spans, true);
    if !specifier_only {
        acc.module_eval_changed = true;
        acc.seeds
            .extend(imp.specifiers.iter().map(|(_, node)| *node));
        return Some(());
    }
    for (spec_span, node) in &imp.specifiers {
        if !span_overlaps(*spec_span, trimmed) {
            continue;
        }
        let reached = bfs_reachable_nodes(&side.graph, &[*node]);
        let mut binding_exports = BTreeSet::new();
        for reached_node in &reached {
            if side.effectful_nodes.contains(reached_node) {
                acc.module_eval_changed = true;
            }
            if let Some(names) = side.exports_by_node.get(reached_node) {
                binding_exports.extend(names.iter().cloned());
            }
        }
        if binding_exports.is_empty() {
            acc.module_eval_changed = true;
        }
        acc.changed_exports.extend(binding_exports);
    }
    Some(())
}

fn attribute_named_export_touch(
    source: &str,
    exp: &NamedExportSpan,
    trimmed: ByteRange,
    acc: &mut TouchAccumulator,
) -> Option<()> {
    if exp.is_type_only {
        return Some(());
    }
    if !exp.all_resolved {
        return None;
    }
    let all_spec_spans = exp
        .specifiers
        .iter()
        .map(|(span, _, _)| *span)
        .chain(exp.type_specifier_spans.iter().copied())
        .collect::<Vec<_>>();
    let specifier_only = range_covered_with(source, trimmed, &all_spec_spans, true);
    for (spec_span, name, node) in &exp.specifiers {
        if !specifier_only || span_overlaps(*spec_span, trimmed) {
            acc.changed_exports.insert(name.clone());
            acc.seeds.push(*node);
        }
    }
    Some(())
}

fn attribute_reexport_from_touch(
    source: &str,
    reexp: &ReexportFromSpan,
    trimmed: ByteRange,
    acc: &mut TouchAccumulator,
) {
    if reexp.is_type_only {
        return;
    }
    let all_spec_spans = reexp
        .specifiers
        .iter()
        .map(|(span, _)| *span)
        .chain(reexp.type_specifier_spans.iter().copied())
        .collect::<Vec<_>>();
    let specifier_only = !span_overlaps(reexp.source_span, trimmed)
        && range_covered_with(source, trimmed, &all_spec_spans, true);
    if !specifier_only && span_overlaps(reexp.source_span, trimmed) {
        acc.module_eval_changed = true;
    }
    for (spec_span, name) in &reexp.specifiers {
        if !specifier_only || span_overlaps(*spec_span, trimmed) {
            acc.changed_exports.insert(name.clone());
        }
    }
}
