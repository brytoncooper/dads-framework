//! Which exported names own which source spans. This is the only place that bridges an export
//! entry to the semantic declaration node whose boundary a changed hunk can be attributed to.

use crate::facts::{JsSpan, JsSymbolFact, JsUncertainty};
use crate::spans::{copied_span, span_is_contained_by};
use oxc_ast::AstKind;
use oxc_semantic::Semantic;
use oxc_span::{GetSpan, Span};
use oxc_syntax::module_record::ModuleRecord;
use oxc_syntax::symbol::SymbolId;

/// Copies only runtime export names whose locally-owned declaration boundary is unique.
///
/// Module records deliberately point at names in export syntax. That is enough for import facts,
/// but not for a hunk inside a function, class, or initializer. Semantic symbols bridge that gap:
/// an export entry identifies its local binding and the file-local semantic record identifies the
/// declaration node that owns its complete source span. Oxc IDs stay inside this function; only
/// copied names and spans leave the adapter.
pub(crate) fn runtime_export_declarations(
    module_record: &ModuleRecord<'_>,
    semantic: &Semantic<'_>,
    path: &str,
    uncertainties: &mut Vec<JsUncertainty>,
) -> Vec<JsSymbolFact> {
    if path.ends_with(".d.ts") || path.ends_with(".d.mts") || path.ends_with(".d.cts") {
        // Ambient TypeScript declaration files contain no runtime exports; type-only edges
        // still flow through module imports for typecheck tasks.
        return Vec::new();
    }
    let mut declarations = Vec::new();
    if let Some(default_export) = module_record
        .local_export_entries
        .iter()
        .find(|entry| entry.export_name.is_default())
    {
        uncertainties.push(JsUncertainty {
            path: path.to_owned(),
            code: "ambiguous-default-export".to_owned(),
            message: "A default export does not have a stable named-import identity in this graph."
                .to_owned(),
            span: Some(copied_span(default_export.span)),
            position: None,
        });
    }
    use oxc_syntax::module_record::ExportExportName;
    for (export_name, export_span) in &module_record.exported_bindings {
        let entries = module_record
            .local_export_entries
            .iter()
            .filter(|entry| {
                !entry.is_type
                    && matches!(&entry.export_name, ExportExportName::Name(name) if name.name == *export_name)
            })
            .collect::<Vec<_>>();
        let Some(first_entry) = entries.first() else {
            // Re-exports, export-star, and type-only exports do not identify one local runtime
            // declaration. Keep existing conservative handling.
            let _ = export_span;
            continue;
        };
        let Some(local_name) = first_entry.local_name.name() else {
            // This is normally an anonymous/default form, already recorded above as an explicit
            // uncertainty. Leave its hunk unattributed as well.
            continue;
        };
        if !entries
            .iter()
            .all(|entry| entry.local_name.name() == Some(local_name))
        {
            continue;
        }
        let mut symbol_ids = entries
            .iter()
            .flat_map(|entry| {
                matching_local_export_symbols(semantic, local_name.as_str(), entry.span)
            })
            .collect::<Vec<_>>();
        symbol_ids.sort_unstable();
        symbol_ids.dedup();
        let entry = *first_entry;
        let [symbol_id] = symbol_ids.as_slice() else {
            uncertainties.push(JsUncertainty {
                path: path.to_owned(),
                code: "ambiguous-local-export-ownership".to_owned(),
                message: format!(
                    "{} does not resolve to one local runtime declaration.",
                    export_name
                ),
                span: Some(copied_span(entry.span)),
                position: None,
            });
            continue;
        };
        let Some(span) = runtime_declaration_span(semantic, *symbol_id) else {
            uncertainties.push(JsUncertainty {
                path: path.to_owned(),
                code: "ambiguous-local-export-ownership".to_owned(),
                message: format!(
                    "{} does not have one safe runtime declaration boundary.",
                    export_name
                ),
                span: Some(copied_span(entry.span)),
                position: None,
            });
            continue;
        };
        declarations.push(JsSymbolFact {
            name: export_name.to_string(),
            span,
        });
    }
    declarations.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then(left.span.start.cmp(&right.span.start))
    });
    declarations.dedup();
    declarations
}

fn matching_local_export_symbols(
    semantic: &Semantic<'_>,
    local_name: &str,
    export_entry_span: Span,
) -> Vec<SymbolId> {
    let scoping = semantic.scoping();
    scoping
        .symbol_ids()
        .filter(|symbol_id| {
            if scoping.symbol_name(*symbol_id) != local_name
                || scoping.symbol_scope_id(*symbol_id) != scoping.root_scope_id()
            {
                return false;
            }
            let flags = scoping.symbol_flags(*symbol_id);
            if !flags.is_value() || flags.is_import() || flags.is_ambient() {
                return false;
            }
            let declaration_span = scoping.symbol_span(*symbol_id);
            let declaration_is_in_export =
                span_is_contained_by(declaration_span, export_entry_span)
                    || scoping.symbol_declarations(*symbol_id).any(|node_id| {
                        span_is_contained_by(
                            semantic.nodes().get_node(node_id).span(),
                            export_entry_span,
                        )
                    });
            let exported_reference_resolves_to_symbol = scoping
                .get_resolved_references(*symbol_id)
                .any(|reference| {
                    span_is_contained_by(
                        semantic.nodes().get_node(reference.node_id()).span(),
                        export_entry_span,
                    )
                });
            declaration_is_in_export || exported_reference_resolves_to_symbol
        })
        .collect()
}

fn is_ts_function_overload_signature(
    semantic: &Semantic<'_>,
    node_id: oxc_syntax::node::NodeId,
) -> bool {
    let nodes = semantic.nodes();
    match nodes.get_node(node_id).kind() {
        AstKind::Function(function) => {
            function.is_declaration() && !function.declare && function.body.is_none()
        }
        AstKind::BindingIdentifier(_) => matches!(
            nodes.parent_kind(node_id),
            AstKind::Function(function)
                if function.is_declaration() && !function.declare && function.body.is_none()
        ),
        _ => false,
    }
}

fn runtime_declaration_span(semantic: &Semantic<'_>, symbol_id: SymbolId) -> Option<JsSpan> {
    let scoping = semantic.scoping();
    let declarations = scoping.symbol_declarations(symbol_id).collect::<Vec<_>>();
    let has_overloads = declarations.len() > 1;
    let runtime_declarations = declarations
        .iter()
        .copied()
        .filter(|node_id| !is_ts_function_overload_signature(semantic, *node_id))
        .collect::<Vec<_>>();
    let [declaration_node_id] = runtime_declarations.as_slice() else {
        // TypeScript declaration merging with multiple runtime owners cannot safely select
        // just one exported runtime identity, so preserve the conservative widening route.
        return None;
    };
    let nodes = semantic.nodes();
    let binding_span = if has_overloads {
        // Pure TS function overload signatures may only merge with one runtime function body.
        let is_runtime_fn = std::iter::once(*declaration_node_id)
            .chain(nodes.ancestor_ids(*declaration_node_id))
            .any(|node_id| {
                matches!(
                    nodes.get_node(node_id).kind(),
                    AstKind::Function(f) if f.is_declaration() && !f.declare && f.body.is_some()
                )
            });
        if !is_runtime_fn {
            return None;
        }
        nodes.get_node(*declaration_node_id).span()
    } else {
        scoping.symbol_span(symbol_id)
    };
    let declaration_spans = std::iter::once(*declaration_node_id)
        .chain(nodes.ancestor_ids(*declaration_node_id))
        .filter_map(|node_id| {
            let node = nodes.get_node(node_id);
            supported_runtime_declaration_span(node.kind())
                .filter(|span| span_is_contained_by(binding_span, *span))
        })
        .collect::<Vec<_>>();
    let [declaration_span] = declaration_spans.as_slice() else {
        // Oxc gives binding identifiers as the declaration node for several syntactic forms.
        // Only one enclosing runtime function, class, or variable declaration is safe to own.
        return None;
    };
    let enclosing_export_spans = std::iter::once(*declaration_node_id)
        .chain(nodes.ancestor_ids(*declaration_node_id))
        .filter_map(|node_id| match nodes.get_node(node_id).kind() {
            AstKind::ExportDeclaration(export)
                if span_is_contained_by(*declaration_span, export.span) =>
            {
                Some(export.span)
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    let ownership_span = match enclosing_export_spans.as_slice() {
        [] => *declaration_span,
        [export_span] => *export_span,
        // Nested or otherwise ambiguous export ownership is not a safe precision boundary.
        _ => return None,
    };
    Some(copied_span(ownership_span))
}

fn supported_runtime_declaration_span(kind: AstKind<'_>) -> Option<Span> {
    match kind {
        AstKind::Function(function)
            if function.is_declaration() && !function.declare && function.body.is_some() =>
        {
            Some(function.span)
        }
        AstKind::Class(class)
            if class.is_declaration() && !class.declare && class.decorators.is_empty() =>
        {
            Some(class.span)
        }
        AstKind::VariableDeclaration(declaration) if !declaration.declare => Some(declaration.span),
        AstKind::TSEnumDeclaration(declaration) if !declaration.declare => Some(declaration.span),
        _ => None,
    }
}

/// `export { imported as publicName }` is a real forwarding declaration even though the imported
/// value remains owned by its source module. Record its own export-statement span so a change to
/// that forwarding statement can propagate `publicName`, while keeping direct `export ... from`
/// and export-star forms uncertain.
pub(crate) fn explicit_import_reexport_declarations(
    source: &str,
    module_record: &ModuleRecord<'_>,
    semantic: &Semantic<'_>,
) -> Vec<JsSymbolFact> {
    use oxc_syntax::module_record::ExportImportName;
    module_record
        .exported_bindings
        .iter()
        .filter_map(|(export_name, export_span)| {
            let entries = module_record
                .indirect_export_entries
                .iter()
                .filter(|entry| {
                    !entry.is_type
                        && entry.export_name.span() == Some(*export_span)
                        && (matches!(entry.import_name, ExportImportName::Name(_))
                            || is_explicit_import_reexport(semantic, entry.span))
                })
                .collect::<Vec<_>>();
            let [entry] = entries.as_slice() else {
                return None;
            };
            let span = enclosing_export_statement_span(source, semantic, entry.span)?;
            Some(JsSymbolFact {
                name: export_name.to_string(),
                span: copied_span(span),
            })
        })
        .collect()
}

pub(crate) fn is_explicit_import_reexport(
    semantic: &Semantic<'_>,
    export_entry_span: Span,
) -> bool {
    let scoping = semantic.scoping();
    scoping.symbol_ids().any(|symbol_id| {
        scoping.symbol_flags(symbol_id).is_import()
            && !scoping.symbol_flags(symbol_id).is_type_import()
            && scoping.get_resolved_references(symbol_id).any(|reference| {
                span_is_contained_by(
                    semantic.nodes().get_node(reference.node_id()).span(),
                    export_entry_span,
                )
            })
    })
}

fn enclosing_export_statement_span(
    source: &str,
    semantic: &Semantic<'_>,
    export_entry_span: Span,
) -> Option<Span> {
    semantic
        .nodes()
        .iter()
        .map(|node| node.span())
        .filter(|span| span_is_contained_by(export_entry_span, *span))
        .filter(|span| {
            source
                .get(span.start as usize..span.end as usize)
                .is_some_and(|text| text.trim_start().starts_with("export"))
        })
        .min_by_key(|span| span.end.saturating_sub(span.start))
}

pub(crate) fn ambiguous_reexport_uncertainty(
    module_record: &ModuleRecord<'_>,
    semantic: &Semantic<'_>,
    path: &str,
) -> Option<JsUncertainty> {
    use oxc_syntax::module_record::{ExportExportName, ExportImportName};
    let ambiguous_reexport = module_record.indirect_export_entries.iter().find(|entry| {
        let is_named_ns_reexport = matches!(entry.import_name, ExportImportName::All)
            && matches!(entry.export_name, ExportExportName::Name(_));
        !entry.is_type
            && !matches!(entry.import_name, ExportImportName::Name(_))
            && !is_named_ns_reexport
            && !is_explicit_import_reexport(semantic, entry.span)
    })?;
    Some(JsUncertainty {
        path: path.to_owned(),
        code: "ambiguous-re-export".to_owned(),
        message: "A cross-file re-export cannot be attributed to a local exported declaration."
            .to_owned(),
        span: Some(copied_span(ambiguous_reexport.span)),
        position: None,
    })
}
