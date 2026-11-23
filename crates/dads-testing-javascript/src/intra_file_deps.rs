//! Sound intra-file def-use projection for pure top-level ES modules.
//!
//! When every top-level statement in a module is side-effect-free (imports, exports, functions,
//! classes, type declarations, or pure variable initializers), Oxc's resolved reference table
//! proves which own exports transitively depend on each imported symbol. Any top-level side
//! effect or unanalyzable construct leaves `export_deps = None`, falling back conservatively to
//! propagating every own export of the module.

use crate::facts::{JsImportFact, JsImportKind};
use crate::intra_file_purity::{
    DeclNode, find_root_symbol, record_pure_declaration, record_pure_default_export,
};
use oxc_ast::ast::{Program, Statement};
use oxc_semantic::Semantic;
use oxc_span::{GetSpan, Span};
use oxc_syntax::module_record::{
    ExportExportName, ExportImportName, ImportImportName, ModuleRecord,
};
use oxc_syntax::symbol::SymbolId;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

pub(crate) fn attach_intra_file_export_deps(
    program: &Program<'_>,
    module_record: &ModuleRecord<'_>,
    semantic: &Semantic<'_>,
    has_uncertainties: bool,
    imports: &mut [JsImportFact],
) {
    attach_indirect_reexport_deps(module_record, imports);
    if has_uncertainties {
        return;
    }
    let Some(decl_spans) = collect_pure_top_level_decls(program, semantic) else {
        return;
    };
    let export_specifier_spans = collect_bare_export_spans(program);
    let Some(graph) = build_intra_file_graph(semantic, &decl_spans, &export_specifier_spans) else {
        return;
    };
    let exports_by_node = map_nodes_to_export_names(module_record, semantic);

    for import in imports.iter_mut() {
        if import.kind != JsImportKind::StaticImport || import.namespace_import {
            continue;
        }
        let mut deps = BTreeMap::<String, BTreeSet<String>>::new();
        for requested in &import.requested_symbols {
            let seeds = matching_import_symbols(module_record, semantic, import, requested);
            if seeds.is_empty() {
                deps.clear();
                break;
            }
            let reached = bfs_affected_exports(&graph, &exports_by_node, &seeds);
            deps.insert(requested.clone(), reached);
        }
        if !import.requested_symbols.is_empty() && deps.len() == import.requested_symbols.len() {
            import.export_deps = Some(deps);
        }
    }
}

/// Direct named re-exports (`export { a as b } from "./x"`) map imported name `a` -> own export `b`.
fn attach_indirect_reexport_deps(module_record: &ModuleRecord<'_>, imports: &mut [JsImportFact]) {
    for import in imports.iter_mut() {
        if import.kind != JsImportKind::ExportFrom || import.reexport_all || import.namespace_import
        {
            continue;
        }
        let mut deps = BTreeMap::<String, BTreeSet<String>>::new();
        for entry in &module_record.indirect_export_entries {
            let Some(module_request) = &entry.module_request else {
                continue;
            };
            if module_request.name != import.specifier
                || entry.statement_span.start > import.span.start
                || import.span.end > entry.statement_span.end
            {
                continue;
            }
            if let (ExportImportName::Name(imp), ExportExportName::Name(exp)) =
                (&entry.import_name, &entry.export_name)
            {
                deps.entry(imp.name.to_string())
                    .or_default()
                    .insert(exp.name.to_string());
            }
        }
        if !deps.is_empty() && deps.len() == import.requested_symbols.len() {
            import.export_deps = Some(deps);
        }
    }
}

fn collect_pure_top_level_decls(
    program: &Program<'_>,
    semantic: &Semantic<'_>,
) -> Option<Vec<(Span, DeclNode)>> {
    let mut decls = Vec::new();
    for stmt in &program.body {
        match stmt {
            Statement::ImportDeclaration(_)
            | Statement::ExportAllDeclaration(_)
            | Statement::ExportNamedDeclaration(_)
            | Statement::ExportFromDeclaration(_) => {}
            Statement::ExportDeclaration(export) => {
                record_pure_declaration(&export.declaration, semantic, &mut decls)?;
            }
            Statement::ExportDefaultDeclaration(export) => {
                record_pure_default_export(&export.declaration, export.span, semantic, &mut decls)?;
            }
            other => {
                let decl = other.as_declaration()?;
                record_pure_declaration(decl, semantic, &mut decls)?;
            }
        }
    }
    Some(decls)
}

fn collect_bare_export_spans(program: &Program<'_>) -> Vec<Span> {
    program
        .body
        .iter()
        .filter_map(|stmt| match stmt {
            Statement::ExportNamedDeclaration(export) => Some(export.span),
            _ => None,
        })
        .collect()
}

fn build_intra_file_graph(
    semantic: &Semantic<'_>,
    decl_spans: &[(Span, DeclNode)],
    export_specifier_spans: &[Span],
) -> Option<BTreeMap<DeclNode, BTreeSet<DeclNode>>> {
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();
    let root_scope = scoping.root_scope_id();
    let mut graph = BTreeMap::<DeclNode, BTreeSet<DeclNode>>::new();

    for sym in scoping.symbol_ids() {
        if scoping.symbol_scope_id(sym) != root_scope {
            continue;
        }
        let from = DeclNode::Symbol(sym);
        for reference in scoping.get_resolved_references(sym) {
            let ref_span = nodes.get_node(reference.node_id()).span();
            if let Some((_, owner)) = decl_spans
                .iter()
                .find(|(span, _)| span.start <= ref_span.start && ref_span.end <= span.end)
            {
                if *owner != from {
                    graph.entry(from).or_default().insert(*owner);
                }
            } else if !export_specifier_spans
                .iter()
                .any(|span| span.start <= ref_span.start && ref_span.end <= span.end)
            {
                return None;
            }
        }
    }
    Some(graph)
}

fn map_nodes_to_export_names(
    module_record: &ModuleRecord<'_>,
    semantic: &Semantic<'_>,
) -> BTreeMap<DeclNode, BTreeSet<String>> {
    let mut map = BTreeMap::<DeclNode, BTreeSet<String>>::new();
    for entry in &module_record.local_export_entries {
        let Some(export_name) = export_name_str(&entry.export_name) else {
            continue;
        };
        if let Some(local_name) = entry.local_name.name() {
            if let Some(sym) = find_root_symbol_by_name(semantic, local_name.as_str()) {
                map.entry(DeclNode::Symbol(sym))
                    .or_default()
                    .insert(export_name);
            }
        } else if export_name == "default" {
            map.entry(DeclNode::DefaultExport)
                .or_default()
                .insert(export_name);
        }
    }
    map
}

fn export_name_str(name: &ExportExportName<'_>) -> Option<String> {
    match name {
        ExportExportName::Name(n) => Some(n.name.to_string()),
        ExportExportName::Default(_) => Some("default".to_owned()),
        ExportExportName::Null => None,
    }
}

fn matching_import_symbols(
    module_record: &ModuleRecord<'_>,
    semantic: &Semantic<'_>,
    import: &JsImportFact,
    requested: &str,
) -> Vec<DeclNode> {
    let mut seeds = Vec::new();
    for entry in &module_record.import_entries {
        if entry.module_request.name != import.specifier
            || entry.statement_span.start > import.span.start
            || import.span.end > entry.statement_span.end
        {
            continue;
        }
        let matches = match &entry.import_name {
            ImportImportName::Name(n) => n.name.as_str() == requested,
            ImportImportName::Default(_) => requested == "default",
            ImportImportName::NamespaceObject => true,
        };
        if matches
            && let Some(sym) = find_root_symbol(
                semantic,
                entry.local_name.name.as_str(),
                entry.local_name.span,
            )
        {
            seeds.push(DeclNode::Symbol(sym));
        }
    }
    seeds
}

fn bfs_affected_exports(
    graph: &BTreeMap<DeclNode, BTreeSet<DeclNode>>,
    exports_by_node: &BTreeMap<DeclNode, BTreeSet<String>>,
    seeds: &[DeclNode],
) -> BTreeSet<String> {
    let mut seen = BTreeSet::new();
    let mut queue = VecDeque::new();
    for seed in seeds {
        if seen.insert(*seed) {
            queue.push_back(*seed);
        }
    }
    let mut affected = BTreeSet::new();
    while let Some(node) = queue.pop_front() {
        if let Some(names) = exports_by_node.get(&node) {
            affected.extend(names.iter().cloned());
        }
        if let Some(nexts) = graph.get(&node) {
            for next in nexts {
                if seen.insert(*next) {
                    queue.push_back(*next);
                }
            }
        }
    }
    affected
}

fn find_root_symbol_by_name(semantic: &Semantic<'_>, name: &str) -> Option<SymbolId> {
    let scoping = semantic.scoping();
    let root_scope = scoping.root_scope_id();
    scoping.get_binding(root_scope, name.into())
}
