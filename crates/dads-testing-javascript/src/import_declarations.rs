//! What one import statement actually requests, and the fact that records it. Type-only bindings,
//! namespace objects, and export-star forms are separated here so the graph can stay precise.

use crate::facts::{JsImportFact, JsImportKind, JsSpan, JsUncertainty};
use crate::file_discovery::WorkspaceFileIndex;
use crate::specifier_resolution::{ResolveContext, ResolvedSpecifier, resolve_static_specifier};
use oxc_ast::AstKind;
use oxc_ast::ast::{BindingPattern, Expression};
use oxc_resolver::Resolver;
use oxc_semantic::Semantic;
use oxc_span::{GetSpan, Span};
use oxc_syntax::module_record::{
    ExportExportName, ExportImportName, ImportImportName, ModuleRecord,
};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub(crate) struct RequestedBindingFacts {
    pub(crate) type_only: bool,
    pub(crate) requested_symbols: BTreeSet<String>,
    pub(crate) namespace_import: bool,
    pub(crate) reexport_all: bool,
    pub(crate) reexport_namespace: Option<String>,
    pub(crate) member_reads: Option<BTreeMap<String, BTreeSet<String>>>,
}

pub(crate) fn requested_binding_facts(
    module_record: &ModuleRecord<'_>,
    semantic: &Semantic<'_>,
    specifier: &str,
    statement_span: Span,
    request_is_type_only: bool,
) -> RequestedBindingFacts {
    let mut facts = RequestedBindingFacts {
        type_only: false,
        requested_symbols: BTreeSet::new(),
        namespace_import: false,
        reexport_all: false,
        reexport_namespace: None,
        member_reads: None,
    };
    let mut member_reads = BTreeMap::<String, BTreeSet<String>>::new();
    let mut has_type_only_binding = request_is_type_only;
    let mut has_runtime_binding = false;
    let mut type_requested_symbols = BTreeSet::new();
    collect_import_entry_bindings(
        module_record,
        semantic,
        specifier,
        statement_span,
        &mut BindingAccumulator {
            facts: &mut facts,
            member_reads: &mut member_reads,
            has_type_only_binding: &mut has_type_only_binding,
            has_runtime_binding: &mut has_runtime_binding,
            type_requested_symbols: &mut type_requested_symbols,
        },
    );
    for entry in &module_record.star_export_entries {
        let Some(module_request) = &entry.module_request else {
            continue;
        };
        if module_request.name != specifier || entry.statement_span != statement_span {
            continue;
        }
        if entry.is_type {
            has_type_only_binding = true;
            if let ExportImportName::Name(name) = &entry.import_name {
                type_requested_symbols.insert(name.name.to_string());
            }
            continue;
        }
        has_runtime_binding = true;
        if entry.import_name.is_all_but_default() {
            facts.reexport_all = true;
        }
    }
    for entry in &module_record.indirect_export_entries {
        let Some(module_request) = &entry.module_request else {
            continue;
        };
        if module_request.name != specifier || entry.statement_span != statement_span {
            continue;
        }
        if entry.is_type {
            has_type_only_binding = true;
            if let ExportImportName::Name(name) = &entry.import_name {
                type_requested_symbols.insert(name.name.to_string());
            }
            continue;
        }
        has_runtime_binding = true;
        match &entry.import_name {
            ExportImportName::Name(name) => {
                facts.requested_symbols.insert(name.name.to_string());
            }
            ExportImportName::All => {
                if let ExportExportName::Name(exported_ns) = &entry.export_name
                    && facts.reexport_namespace.is_none()
                {
                    facts.reexport_namespace = Some(exported_ns.name.to_string());
                } else {
                    facts.namespace_import = true;
                }
            }
            ExportImportName::AllButDefault | ExportImportName::Null => {
                facts.namespace_import = true;
            }
        }
    }
    facts.type_only = has_type_only_binding && !has_runtime_binding;
    if facts.type_only {
        facts.requested_symbols = type_requested_symbols;
    } else if !member_reads.is_empty() {
        facts.member_reads = Some(member_reads);
    }
    facts
}

struct BindingAccumulator<'a> {
    facts: &'a mut RequestedBindingFacts,
    member_reads: &'a mut BTreeMap<String, BTreeSet<String>>,
    has_type_only_binding: &'a mut bool,
    has_runtime_binding: &'a mut bool,
    type_requested_symbols: &'a mut BTreeSet<String>,
}

fn collect_import_entry_bindings(
    module_record: &ModuleRecord<'_>,
    semantic: &Semantic<'_>,
    specifier: &str,
    statement_span: Span,
    acc: &mut BindingAccumulator<'_>,
) {
    for entry in &module_record.import_entries {
        if entry.module_request.name != specifier || entry.statement_span != statement_span {
            continue;
        }
        if entry.is_type {
            *acc.has_type_only_binding = true;
            match &entry.import_name {
                ImportImportName::Name(name) => {
                    acc.type_requested_symbols.insert(name.name.to_string());
                }
                ImportImportName::Default(_) => {
                    acc.type_requested_symbols.insert("default".to_owned());
                }
                ImportImportName::NamespaceObject => {}
            }
            continue;
        }
        *acc.has_runtime_binding = true;
        match &entry.import_name {
            ImportImportName::Name(name) => {
                let imported = name.name.to_string();
                acc.facts.requested_symbols.insert(imported.clone());
                if let Some(members) = tracked_namespace_members(
                    semantic,
                    entry.local_name.name.as_str(),
                    entry.local_name.span,
                ) {
                    acc.member_reads
                        .entry(imported)
                        .or_default()
                        .extend(members);
                }
            }
            ImportImportName::Default(_) => {
                acc.facts.requested_symbols.insert("default".to_owned());
                if let Some(members) = tracked_namespace_members(
                    semantic,
                    entry.local_name.name.as_str(),
                    entry.local_name.span,
                ) {
                    acc.member_reads
                        .entry("default".to_owned())
                        .or_default()
                        .extend(members);
                }
            }
            ImportImportName::NamespaceObject => {
                if let Some(members) = tracked_namespace_members(
                    semantic,
                    entry.local_name.name.as_str(),
                    entry.local_name.span,
                ) {
                    acc.facts.requested_symbols.extend(members);
                } else {
                    acc.facts.namespace_import = true;
                }
            }
        }
    }
}

/// If every runtime reference to `import * as ns` is a direct static property read (`ns.foo`),
/// returns the exact set of accessed member names so the import stays symbol-precise. Any escape
/// (passing `ns` as a value, spreading `{ ...ns }`, computed index `ns[k]`, or zero references)
/// returns `None` to keep the conservative namespace uncertainty.
fn tracked_namespace_members(
    semantic: &Semantic<'_>,
    local_name: &str,
    binding_span: Span,
) -> Option<BTreeSet<String>> {
    let scoping = semantic.scoping();
    let symbol_id = scoping.symbol_ids().find(|symbol_id| {
        scoping.symbol_name(*symbol_id) == local_name
            && scoping.symbol_span(*symbol_id) == binding_span
    })?;
    let nodes = semantic.nodes();
    let mut members = BTreeSet::new();
    let mut saw_reference = false;
    for reference in scoping.get_resolved_references(symbol_id) {
        if !reference.is_read() || reference.is_write() {
            return None;
        }
        saw_reference = true;
        let ref_node_id = reference.node_id();
        let ref_span = nodes.get_node(ref_node_id).span();
        let parent = nodes.parent_node(ref_node_id);
        match parent.kind() {
            AstKind::StaticMemberExpression(member) if matches!(&member.object, Expression::Identifier(ident) if ident.span == ref_span) =>
            {
                members.insert(member.property.name.to_string());
            }
            _ => return None,
        }
    }
    saw_reference.then_some(members)
}

/// If a static-specifier `await import("./mod")` is immediately destructured into explicit static
/// properties (`const { foo, bar: baz } = await import("./mod")`) with no rest element, or bound to
/// a local identifier whose every read is a static member access (`mod.foo`), returns those exact
/// requested export names. Bare side-effect imports, rest spreads, computed keys, and escaped
/// bindings return an empty set so the planner widens conservatively.
pub(crate) fn dynamic_import_requested_symbols(
    semantic: &Semantic<'_>,
    module_request_span: Span,
) -> BTreeSet<String> {
    let nodes = semantic.nodes();
    let Some(import_node) = nodes.iter().find(|node| {
        matches!(
            node.kind(),
            AstKind::ImportExpression(expr) if expr.source.span() == module_request_span
        )
    }) else {
        return BTreeSet::new();
    };
    let await_node = nodes.parent_node(import_node.id());
    if !matches!(await_node.kind(), AstKind::AwaitExpression(_)) {
        return BTreeSet::new();
    }
    let declarator_node = nodes.parent_node(await_node.id());
    let AstKind::VariableDeclarator(declarator) = declarator_node.kind() else {
        return BTreeSet::new();
    };
    match &declarator.id {
        BindingPattern::ObjectPattern(pattern) => {
            if pattern.rest.is_some() || pattern.properties.is_empty() {
                return BTreeSet::new();
            }
            let mut symbols = BTreeSet::new();
            for prop in &pattern.properties {
                if prop.computed {
                    return BTreeSet::new();
                }
                let Some(name) = prop.key.static_name() else {
                    return BTreeSet::new();
                };
                symbols.insert(name.into_owned());
            }
            symbols
        }
        BindingPattern::BindingIdentifier(ident) => {
            tracked_namespace_members(semantic, ident.name.as_str(), ident.span).unwrap_or_default()
        }
        _ => BTreeSet::new(),
    }
}

pub(crate) struct ImportFactContext<'a> {
    pub(crate) workspace_root: &'a Path,
    pub(crate) absolute_path: &'a Path,
    pub(crate) path: &'a str,
    pub(crate) resolver: &'a Resolver,
    pub(crate) workspace_index: &'a WorkspaceFileIndex,
    pub(crate) uncertainties: &'a mut Vec<JsUncertainty>,
}

pub(crate) struct ImportFactInput<'a> {
    pub(crate) specifier: &'a str,
    pub(crate) span: JsSpan,
    pub(crate) kind: JsImportKind,
    pub(crate) type_only: bool,
    pub(crate) requested_symbols: BTreeSet<String>,
    pub(crate) namespace_import: bool,
    pub(crate) reexport_all: bool,
    pub(crate) reexport_namespace: Option<String>,
    pub(crate) member_reads: Option<BTreeMap<String, BTreeSet<String>>>,
}

pub(crate) fn import_fact(
    context: ImportFactContext<'_>,
    input: ImportFactInput<'_>,
) -> JsImportFact {
    let resolve_ctx = ResolveContext {
        workspace_root: context.workspace_root,
        absolute_path: context.absolute_path,
        path: context.path,
        resolver: context.resolver,
        workspace_index: context.workspace_index,
    };
    match resolve_static_specifier(
        &resolve_ctx,
        input.specifier,
        input.span,
        context.uncertainties,
    ) {
        Some(ResolvedSpecifier::Asset(asset_path)) => JsImportFact {
            specifier: input.specifier.to_owned(),
            span: input.span,
            kind: JsImportKind::Asset,
            type_only: input.type_only,
            requested_symbols: BTreeSet::new(),
            namespace_import: false,
            reexport_all: false,
            reexport_namespace: None,
            resolved_path: Some(asset_path),
            position: None,
            export_deps: None,
            member_reads: None,
        },
        resolved => JsImportFact {
            specifier: input.specifier.to_owned(),
            span: input.span,
            kind: input.kind,
            type_only: input.type_only,
            requested_symbols: input.requested_symbols,
            namespace_import: input.namespace_import,
            reexport_all: input.reexport_all,
            reexport_namespace: input.reexport_namespace,
            resolved_path: match resolved {
                Some(ResolvedSpecifier::JavaScript(path)) => Some(path),
                _ => None,
            },
            position: None,
            export_deps: None,
            member_reads: input.member_reads,
        },
    }
}
