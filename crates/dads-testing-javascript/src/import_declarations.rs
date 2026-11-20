//! What one import statement actually requests, and the fact that records it. Type-only bindings,
//! namespace objects, and export-star forms are separated here so the graph can stay precise.

use crate::facts::{JsImportFact, JsImportKind, JsSpan, JsUncertainty};
use crate::specifier_resolution::resolve_static_specifier;
use oxc_resolver::Resolver;
use oxc_span::Span;
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
    for entry in &module_record.import_entries {
        if entry.module_request.name != specifier || entry.statement_span != statement_span {
            continue;
        }
        if entry.is_type {
            has_type_only_binding = true;
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
            ImportImportName::NamespaceObject => facts.namespace_import = true,
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
    facts
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
    }
}
