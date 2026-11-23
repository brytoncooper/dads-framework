//! What one import statement actually requests, and the fact that records it. Type-only bindings,
//! namespace objects, and export-star forms are separated here so the graph can stay precise.

use crate::facts::{JsImportFact, JsImportKind, JsSpan, JsUncertainty};
use crate::specifier_resolution::resolve_static_specifier;
use oxc_ast::AstKind;
use oxc_ast::ast::Expression;
use oxc_resolver::Resolver;
use oxc_semantic::Semantic;
use oxc_span::{GetSpan, Span};
use oxc_syntax::module_record::{ExportImportName, ImportImportName, ModuleRecord};
use std::collections::BTreeSet;
use std::path::Path;

pub(crate) struct RequestedBindingFacts {
    pub(crate) type_only: bool,
    pub(crate) requested_symbols: BTreeSet<String>,
    pub(crate) namespace_import: bool,
    pub(crate) reexport_all: bool,
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
    };
    let mut has_type_only_binding = request_is_type_only;
    let mut has_runtime_binding = false;
    let mut type_requested_symbols = BTreeSet::new();
    for entry in &module_record.import_entries {
        if entry.module_request.name != specifier || entry.statement_span != statement_span {
            continue;
        }
        if entry.is_type {
            has_type_only_binding = true;
            match &entry.import_name {
                ImportImportName::Name(name) => {
                    type_requested_symbols.insert(name.name.to_string());
                }
                ImportImportName::Default(_) => {
                    type_requested_symbols.insert("default".to_owned());
                }
                ImportImportName::NamespaceObject => {}
            }
            continue;
        }
        has_runtime_binding = true;
        match &entry.import_name {
            ImportImportName::Name(name) => {
                facts.requested_symbols.insert(name.name.to_string());
            }
            ImportImportName::Default(_) => {
                facts.requested_symbols.insert("default".to_owned());
            }
            ImportImportName::NamespaceObject => {
                if let Some(members) = tracked_namespace_members(
                    semantic,
                    entry.local_name.name.as_str(),
                    entry.local_name.span,
                ) {
                    facts.requested_symbols.extend(members);
                } else {
                    facts.namespace_import = true;
                }
            }
        }
    }
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
            ExportImportName::All | ExportImportName::AllButDefault => {
                facts.namespace_import = true
            }
            ExportImportName::Null => facts.namespace_import = true,
        }
    }
    facts.type_only = has_type_only_binding && !has_runtime_binding;
    if facts.type_only {
        facts.requested_symbols = type_requested_symbols;
    }
    facts
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

pub(crate) struct ImportFactContext<'a> {
    pub(crate) workspace_root: &'a Path,
    pub(crate) absolute_path: &'a Path,
    pub(crate) path: &'a str,
    pub(crate) resolver: &'a Resolver,
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
}

pub(crate) fn import_fact(
    context: ImportFactContext<'_>,
    input: ImportFactInput<'_>,
) -> JsImportFact {
    let resolved_path = resolve_static_specifier(
        context.workspace_root,
        context.absolute_path,
        context.path,
        context.resolver,
        input.specifier,
        input.span,
        context.uncertainties,
    );
    JsImportFact {
        specifier: input.specifier.to_owned(),
        span: input.span,
        kind: input.kind,
        type_only: input.type_only,
        requested_symbols: input.requested_symbols,
        namespace_import: input.namespace_import,
        reexport_all: input.reexport_all,
        resolved_path,
        position: None,
        export_deps: None,
    }
}
