//! One file at a time: read the source, parse the module, collect its imports, and locate every
//! recorded span. Oxc arena values live only inside this module; callers receive owned facts.

use crate::commonjs::{scan_commonjs_module_value_exports, scan_commonjs_requires};
use crate::export_declarations::{
    explicit_import_reexport_declarations, is_explicit_import_reexport, runtime_export_declarations,
};
use crate::facts::{
    JsImportFact, JsImportKind, JsLanguage, JsModuleFacts, JsSymbolFact, JsUncertainty,
};
use crate::import_declarations::{
    ImportFactContext, ImportFactInput, import_fact, requested_binding_facts,
};
use crate::intra_file_deps::attach_intra_file_export_deps;
use crate::spans::{copied_span, line_and_column, static_string_at_span};
use crate::workspace::uncertainty;
use oxc_allocator::Allocator;
use oxc_parser::{Parser, ParserReturn};
use oxc_resolver::Resolver;
use oxc_semantic::{Semantic, SemanticBuilder, SemanticBuilderReturn};
use oxc_span::SourceType;
use oxc_syntax::module_record::ModuleRecord;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

/// Everything an import reader needs to turn one specifier into a resolved fact.
struct ImportScan<'a> {
    workspace_root: &'a Path,
    absolute_path: &'a Path,
    path: &'a str,
    resolver: &'a Resolver,
    source: &'a str,
}

pub(crate) fn analyze_file(
    workspace_root: &Path,
    absolute_path: &Path,
    path: &str,
    resolver: &Resolver,
) -> Result<(JsModuleFacts, Vec<JsUncertainty>), JsUncertainty> {
    let (source, source_type) = read_source(workspace_root, absolute_path)?;
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, &source, source_type).parse();
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .with_check_syntax_error(true)
        .build(&parsed.program);
    let mut uncertainties = syntax_uncertainties(path, &parsed, &semantic);

    let module_record: &ModuleRecord<'_> = &parsed.module_record;
    let declarations = exported_declarations(
        &source,
        module_record,
        &semantic.semantic,
        path,
        &mut uncertainties,
    );
    let references = imported_local_references(module_record);
    let scan = ImportScan {
        workspace_root,
        absolute_path,
        path,
        resolver,
        source: &source,
    };
    let mut imports = collect_imports(&scan, module_record, &semantic.semantic, &mut uncertainties);
    attach_intra_file_export_deps(
        &parsed.program,
        module_record,
        &semantic.semantic,
        !uncertainties.is_empty(),
        &mut imports,
    );
    locate_positions(&source, &mut imports, &mut uncertainties);

    Ok((
        JsModuleFacts {
            path: path.to_owned(),
            language: if source_type.is_typescript() {
                JsLanguage::TypeScript
            } else {
                JsLanguage::JavaScript
            },
            declarations,
            references,
            imports,
        },
        uncertainties,
    ))
}

fn read_source(
    workspace_root: &Path,
    absolute_path: &Path,
) -> Result<(String, SourceType), JsUncertainty> {
    let source = fs::read_to_string(absolute_path).map_err(|error| {
        uncertainty(
            workspace_root,
            absolute_path,
            "javascript-source-read-failed",
            format!("Could not read source: {error}"),
        )
    })?;
    let source_type = SourceType::from_path(absolute_path).map_err(|error| {
        uncertainty(
            workspace_root,
            absolute_path,
            "javascript-source-type-unknown",
            error.to_string(),
        )
    })?;
    Ok((source, source_type))
}

/// A file that Oxc could not fully parse or resolve locally is uncertain as a whole. Both records
/// point at the first diagnostic label so a plan can name the syntax that stopped the analysis.
fn syntax_uncertainties(
    path: &str,
    parsed: &ParserReturn<'_>,
    semantic: &SemanticBuilderReturn<'_>,
) -> Vec<JsUncertainty> {
    let mut uncertainties = Vec::new();
    if parsed.panicked || !parsed.diagnostics.is_empty() {
        uncertainties.push(JsUncertainty {
            path: path.to_owned(),
            code: "javascript-parse-failed".to_owned(),
            message: "Oxc could not establish a complete JavaScript/TypeScript syntax record."
                .to_owned(),
            span: parsed
                .diagnostics
                .iter()
                .find_map(|diagnostic| diagnostic.labels.first())
                .map(|label| copied_span(label.span())),
            position: None,
        });
    }
    if !semantic.diagnostics.is_empty() {
        uncertainties.push(JsUncertainty {
            path: path.to_owned(),
            code: "javascript-semantic-failed".to_owned(),
            message: "Oxc could not establish complete file-local semantic facts.".to_owned(),
            span: semantic
                .diagnostics
                .iter()
                .find_map(|diagnostic| diagnostic.labels.first())
                .map(|label| copied_span(label.span())),
            position: None,
        });
    }
    uncertainties
}

pub(crate) fn exported_declarations(
    source: &str,
    module_record: &ModuleRecord<'_>,
    semantic: &Semantic<'_>,
    path: &str,
    uncertainties: &mut Vec<JsUncertainty>,
) -> Vec<JsSymbolFact> {
    let mut declarations =
        runtime_export_declarations(module_record, semantic, path, uncertainties);
    declarations.extend(explicit_import_reexport_declarations(
        source,
        module_record,
        semantic,
    ));
    declarations.extend(scan_commonjs_module_value_exports(source));
    declarations.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then(left.span.start.cmp(&right.span.start))
    });
    declarations.dedup();
    declarations
}

fn imported_local_references(module_record: &ModuleRecord<'_>) -> Vec<JsSymbolFact> {
    let mut references = module_record
        .import_entries
        .iter()
        .map(|entry| JsSymbolFact {
            name: entry.local_name.name.to_string(),
            span: copied_span(entry.local_name.span),
        })
        .collect::<Vec<_>>();
    references.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then(left.span.start.cmp(&right.span.start))
    });
    references.dedup();
    references
}

fn collect_imports(
    scan: &ImportScan<'_>,
    module_record: &ModuleRecord<'_>,
    semantic: &Semantic<'_>,
    uncertainties: &mut Vec<JsUncertainty>,
) -> Vec<JsImportFact> {
    let mut imports = requested_module_imports(scan, module_record, semantic, uncertainties);
    if let Some(ambiguous_reexport) =
        ambiguous_reexport_uncertainty(module_record, semantic, scan.path)
    {
        uncertainties.push(ambiguous_reexport);
    }
    imports.extend(dynamic_import_facts(scan, module_record, uncertainties));
    imports.extend(scan_commonjs_requires(
        scan.workspace_root,
        scan.absolute_path,
        scan.path,
        scan.resolver,
        scan.source,
        uncertainties,
    ));
    imports.sort_by(|left, right| {
        left.specifier
            .cmp(&right.specifier)
            .then(left.span.start.cmp(&right.span.start))
    });
    imports
}

fn requested_module_imports(
    scan: &ImportScan<'_>,
    module_record: &ModuleRecord<'_>,
    semantic: &Semantic<'_>,
    uncertainties: &mut Vec<JsUncertainty>,
) -> Vec<JsImportFact> {
    let mut imports = Vec::new();
    for (specifier, requests) in &module_record.requested_modules {
        for request in requests {
            let specifier = specifier.to_string();
            let kind = if request.is_import {
                JsImportKind::StaticImport
            } else {
                JsImportKind::ExportFrom
            };
            let binding = requested_binding_facts(
                module_record,
                semantic,
                &specifier,
                request.statement_span,
                request.is_type,
            );
            let type_only = binding.type_only;
            imports.push(import_fact(
                ImportFactContext {
                    workspace_root: scan.workspace_root,
                    absolute_path: scan.absolute_path,
                    path: scan.path,
                    resolver: scan.resolver,
                    uncertainties: &mut *uncertainties,
                },
                ImportFactInput {
                    specifier: &specifier,
                    span: copied_span(request.span),
                    kind,
                    type_only,
                    requested_symbols: binding.requested_symbols,
                    namespace_import: binding.namespace_import,
                    reexport_all: binding.reexport_all,
                    reexport_namespace: binding.reexport_namespace,
                    member_reads: binding.member_reads,
                },
            ));
        }
    }
    imports
}

fn ambiguous_reexport_uncertainty(
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

fn dynamic_import_facts(
    scan: &ImportScan<'_>,
    module_record: &ModuleRecord<'_>,
    uncertainties: &mut Vec<JsUncertainty>,
) -> Vec<JsImportFact> {
    let mut imports = Vec::new();
    for dynamic_import in &module_record.dynamic_imports {
        let span = copied_span(dynamic_import.module_request);
        match static_string_at_span(scan.source, dynamic_import.module_request) {
            Some(specifier) => imports.push(import_fact(
                ImportFactContext {
                    workspace_root: scan.workspace_root,
                    absolute_path: scan.absolute_path,
                    path: scan.path,
                    resolver: scan.resolver,
                    uncertainties: &mut *uncertainties,
                },
                ImportFactInput {
                    specifier: &specifier,
                    span,
                    kind: JsImportKind::DynamicImport,
                    type_only: false,
                    requested_symbols: BTreeSet::new(),
                    namespace_import: false,
                    reexport_all: false,
                    reexport_namespace: None,
                    member_reads: None,
                },
            )),
            None => uncertainties.push(JsUncertainty {
                path: scan.path.to_owned(),
                code: "nonliteral-dynamic-import".to_owned(),
                message: "A dynamic import does not have a static module specifier.".to_owned(),
                span: Some(span),
                position: None,
            }),
        }
    }
    imports
}

/// One conversion pass: byte spans become human positions while this file's source is still
/// in hand. Nothing downstream re-reads the file to locate an import or an uncertainty.
fn locate_positions(
    source: &str,
    imports: &mut [JsImportFact],
    uncertainties: &mut [JsUncertainty],
) {
    for import in imports {
        import.position = Some(line_and_column(source, import.span.start));
    }
    for uncertainty in uncertainties {
        uncertainty.position = uncertainty
            .span
            .map(|span| line_and_column(source, span.start));
    }
}

/// Extracts only local runtime export declaration spans from a historical source blob. Historical
/// sources are not resolved: their imports may no longer exist in the working tree, but their own
/// declaration boundaries remain enough to attribute deleted and replaced exports.
pub(crate) fn runtime_export_declarations_from_source(
    source: &str,
    path: &Path,
    display_path: &str,
) -> Option<Vec<JsSymbolFact>> {
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
    let mut uncertainties = Vec::new();
    let declarations = exported_declarations(
        source,
        &parsed.module_record,
        &semantic.semantic,
        display_path,
        &mut uncertainties,
    );
    if !uncertainties.is_empty() {
        return None;
    }
    Some(declarations)
}
