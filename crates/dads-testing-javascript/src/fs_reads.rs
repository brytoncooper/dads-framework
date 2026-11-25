//! Native static `fs` read and `import.meta.glob` dependency extraction.
//!
//! Files that neither import/require `fs` (`fs`, `node:fs`, `fs/promises`, `node:fs/promises`)
//! nor mention `import.meta.glob` return immediately with zero AST traversal.

use crate::facts::{JsImportFact, JsImportKind, JsSpan};
use crate::file_discovery::{WorkspaceFileIndex, is_ignored_workspace_rel_path};
use crate::fs_bindings::{
    FS_READ_METHODS, FsBindings, collect_module_bindings, is_fs_module_specifier, is_fs_ns_expr,
    is_fs_promises_expr,
};
use crate::meta_glob::{GlobExpandCtx, expand_meta_glob_call, is_import_meta_glob};
use crate::path_eval::{
    EvalPath, PathEvalCtx, eval_path_expr, ident_resolved_symbol, unwrap_transparent_expr,
};
use crate::spans::copied_span;
use crate::workspace::{normalize_lexical, workspace_relative_path};
use oxc_ast::AstKind;
use oxc_ast::ast::{Argument, BindingPattern, CallExpression, Expression, ObjectPropertyKind};
use oxc_semantic::{NodeId, Semantic};
use oxc_span::{GetSpan, Span};
use oxc_syntax::module_record::ModuleRecord;
use oxc_syntax::symbol::SymbolId;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

const MAX_DIR_EXPANSION_FILES: usize = 2_500;

struct TargetRecorder<'a> {
    current_path: &'a str,
    workspace_index: &'a WorkspaceFileIndex,
    fs_targets: BTreeMap<String, JsSpan>,
    glob_targets: BTreeMap<String, JsSpan>,
}

impl TargetRecorder<'_> {
    fn record_path(&mut self, candidate: &Path, span: Span) {
        let Some(canonical_root) = self.workspace_index.canonical_root() else {
            return;
        };
        let normalized = normalize_lexical(candidate);
        match normalized.canonicalize() {
            Ok(canonical_target) => {
                if !canonical_target.starts_with(canonical_root) {
                    return;
                }
                let Some(rel) = workspace_relative_path(canonical_root, &canonical_target) else {
                    return;
                };
                if rel.is_empty() || rel == "." || is_ignored_workspace_rel_path(&rel) {
                    return;
                }
                if canonical_target.is_file() {
                    self.insert_fs_target(rel, span);
                } else if canonical_target.is_dir() {
                    let files = self.workspace_index.files_under_dir(&rel);
                    if files.len() <= MAX_DIR_EXPANSION_FILES {
                        self.insert_fs_target(format!("{rel}/"), span);
                    }
                }
            }
            Err(_) => {
                if let Some(rel) = resolve_missing_workspace_rel_path(canonical_root, &normalized)
                    && !rel.is_empty()
                    && rel != "."
                    && !is_ignored_workspace_rel_path(&rel)
                {
                    self.insert_fs_target(rel, span);
                }
            }
        }
    }

    fn insert_fs_target(&mut self, rel: String, span: Span) {
        if rel != self.current_path {
            self.fs_targets
                .entry(rel)
                .or_insert_with(|| copied_span(span));
        }
    }
}

fn resolve_missing_workspace_rel_path(canonical_root: &Path, normalized: &Path) -> Option<String> {
    let mut missing_segments = Vec::new();
    let mut cursor = normalized;
    while !cursor.exists() {
        let name = cursor.file_name()?.to_str()?;
        if !is_safe_missing_segment(name) {
            return None;
        }
        missing_segments.push(name);
        cursor = cursor.parent()?;
    }
    if missing_segments.is_empty() {
        return None;
    }
    let canonical_ancestor = cursor.canonicalize().ok()?;
    if !canonical_ancestor.starts_with(canonical_root) {
        return None;
    }
    missing_segments.reverse();
    let mut joined = canonical_ancestor;
    for segment in missing_segments {
        joined.push(segment);
    }
    workspace_relative_path(canonical_root, &joined)
}

fn is_safe_missing_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.bytes().all(|byte| {
            byte >= 0x20 && !matches!(byte, b'*' | b'?' | b':' | b'<' | b'>' | b'|' | b'"')
        })
}

fn synthetic_import_fact(
    specifier: String,
    span: JsSpan,
    kind: JsImportKind,
    resolved_path: String,
) -> JsImportFact {
    JsImportFact {
        specifier,
        span,
        kind,
        type_only: false,
        requested_symbols: BTreeSet::new(),
        namespace_import: false,
        reexport_all: false,
        reexport_namespace: None,
        resolved_path: Some(resolved_path),
        position: None,
        export_deps: None,
        member_reads: None,
    }
}

pub(crate) fn collect_fs_read_imports(
    module_record: &ModuleRecord<'_>,
    semantic: &Semantic<'_>,
    source: &str,
    workspace_root: &Path,
    absolute_path: &Path,
    path: &str,
    workspace_index: &WorkspaceFileIndex,
) -> Vec<JsImportFact> {
    if !may_contain_fs_or_glob(module_record, source) {
        return Vec::new();
    }
    let Some(file_dir) = absolute_path.parent() else {
        return Vec::new();
    };
    let collected = collect_module_bindings(semantic);
    let eval_ctx = PathEvalCtx {
        semantic,
        workspace_root,
        file_path: absolute_path,
        file_dir,
        bindings: &collected.path,
    };
    let glob_ctx = GlobExpandCtx {
        workspace_root,
        file_dir,
        current_path: path,
        workspace_index,
        max_expansion_files: MAX_DIR_EXPANSION_FILES,
    };
    let mut recorder = TargetRecorder {
        current_path: path,
        workspace_index,
        fs_targets: BTreeMap::new(),
        glob_targets: BTreeMap::new(),
    };
    let empty_overrides = HashMap::new();
    let mut saw_fs_read_call = false;
    let mut unresolved_calls: Vec<(NodeId, &Expression<'_>)> = Vec::new();

    for node in semantic.nodes().iter() {
        let AstKind::CallExpression(call) = node.kind() else {
            continue;
        };
        if is_import_meta_glob(call) {
            expand_meta_glob_call(call, &glob_ctx, &mut recorder.glob_targets);
            continue;
        }
        if !is_fs_read_call(call, &collected.fs, semantic) {
            continue;
        }
        saw_fs_read_call = true;
        let Some(arg0) = call.arguments.first().and_then(Argument::as_expression) else {
            continue;
        };
        match eval_path_expr(arg0, &eval_ctx, &empty_overrides) {
            Some(EvalPath::Absolute(resolved)) => recorder.record_path(&resolved, call.span),
            Some(EvalPath::Relative(rel)) => {
                recorder.record_path(&workspace_root.join(rel), call.span);
            }
            None => unresolved_calls.push((node.id(), arg0)),
        }
    }

    resolve_helper_forwarded_calls(&unresolved_calls, &eval_ctx, &mut recorder);
    if saw_fs_read_call {
        resolve_const_array_paths(&collected.const_arrays, &eval_ctx, &mut recorder);
    }

    let mut facts = Vec::with_capacity(recorder.glob_targets.len() + recorder.fs_targets.len());
    for (resolved_path, span) in recorder.glob_targets {
        facts.push(synthetic_import_fact(
            format!("glob:{resolved_path}"),
            span,
            JsImportKind::Asset,
            resolved_path,
        ));
    }
    for (resolved_path, span) in recorder.fs_targets {
        facts.push(synthetic_import_fact(
            format!("fs:{resolved_path}"),
            span,
            JsImportKind::FileRead,
            resolved_path,
        ));
    }
    facts
}

fn may_contain_fs_or_glob(module_record: &ModuleRecord<'_>, source: &str) -> bool {
    if module_record
        .requested_modules
        .keys()
        .any(|spec| is_fs_module_specifier(spec.as_str()))
    {
        return true;
    }
    if source.contains("import.meta.glob") {
        return true;
    }
    source.contains("require(")
        && [
            "'fs'",
            "\"fs\"",
            "'node:fs'",
            "\"node:fs\"",
            "'fs/promises'",
            "\"fs/promises\"",
            "'node:fs/promises'",
            "\"node:fs/promises\"",
        ]
        .iter()
        .any(|needle| source.contains(needle))
}

fn is_fs_read_call(call: &CallExpression<'_>, fs: &FsBindings, semantic: &Semantic<'_>) -> bool {
    match unwrap_transparent_expr(&call.callee) {
        Expression::Identifier(ident) => ident_resolved_symbol(semantic, ident)
            .is_some_and(|sym| fs.direct_read_syms.contains(&sym)),
        Expression::StaticMemberExpression(member) => {
            FS_READ_METHODS.contains(&member.property.name.as_str())
                && (is_fs_ns_expr(&member.object, fs, semantic)
                    || is_fs_promises_expr(&member.object, fs, semantic))
        }
        _ => false,
    }
}

fn resolve_helper_forwarded_calls<'a>(
    unresolved_calls: &[(NodeId, &'a Expression<'a>)],
    ctx: &PathEvalCtx<'a>,
    recorder: &mut TargetRecorder<'_>,
) {
    let nodes = ctx.semantic.nodes();
    let scoping = ctx.semantic.scoping();
    let empty_overrides = HashMap::new();

    for &(call_node_id, fs_arg) in unresolved_calls {
        let Some((helper_sym, param_syms)) = enclosing_helper_signature(ctx.semantic, call_node_id)
        else {
            continue;
        };
        for reference in scoping.get_resolved_references(helper_sym) {
            let ref_node = nodes.get_node(reference.node_id());
            let AstKind::CallExpression(helper_call) =
                nodes.parent_node(reference.node_id()).kind()
            else {
                continue;
            };
            if helper_call.callee.span() != ref_node.span() {
                continue;
            }
            let mut overrides = HashMap::new();
            for (idx, param_sym) in param_syms.iter().enumerate() {
                if let Some(sym) = param_sym
                    && let Some(arg_expr) = helper_call
                        .arguments
                        .get(idx)
                        .and_then(Argument::as_expression)
                    && let Some(val) = eval_path_expr(arg_expr, ctx, &empty_overrides)
                {
                    overrides.insert(*sym, val);
                }
            }
            if overrides.is_empty() {
                continue;
            }
            match eval_path_expr(fs_arg, ctx, &overrides) {
                Some(EvalPath::Absolute(resolved)) => {
                    recorder.record_path(&resolved, helper_call.span);
                }
                Some(EvalPath::Relative(rel)) => {
                    recorder.record_path(&ctx.workspace_root.join(rel), helper_call.span);
                }
                None => {}
            }
        }
    }
}

fn enclosing_helper_signature(
    semantic: &Semantic<'_>,
    node_id: NodeId,
) -> Option<(SymbolId, Vec<Option<SymbolId>>)> {
    let nodes = semantic.nodes();
    for ancestor_id in nodes.ancestor_ids(node_id) {
        match nodes.get_node(ancestor_id).kind() {
            AstKind::Function(func) => {
                let helper_sym = func
                    .id
                    .as_ref()
                    .and_then(|id| id.symbol_id.get())
                    .or_else(|| parent_var_declarator_sym(semantic, ancestor_id))?;
                let params = func
                    .params
                    .items
                    .iter()
                    .map(|item| match &item.pattern {
                        BindingPattern::BindingIdentifier(ident) => ident.symbol_id.get(),
                        _ => None,
                    })
                    .collect();
                return Some((helper_sym, params));
            }
            AstKind::ArrowFunctionExpression(arrow) => {
                let helper_sym = parent_var_declarator_sym(semantic, ancestor_id)?;
                let params = arrow
                    .params
                    .items
                    .iter()
                    .map(|item| match &item.pattern {
                        BindingPattern::BindingIdentifier(ident) => ident.symbol_id.get(),
                        _ => None,
                    })
                    .collect();
                return Some((helper_sym, params));
            }
            _ => {}
        }
    }
    None
}

fn parent_var_declarator_sym(semantic: &Semantic<'_>, node_id: NodeId) -> Option<SymbolId> {
    match semantic.nodes().parent_node(node_id).kind() {
        AstKind::VariableDeclarator(decl) => match &decl.id {
            BindingPattern::BindingIdentifier(ident) => ident.symbol_id.get(),
            _ => None,
        },
        _ => None,
    }
}

fn resolve_const_array_paths<'a>(
    const_arrays: &[(SymbolId, Span, Vec<&'a Expression<'a>>)],
    ctx: &PathEvalCtx<'a>,
    recorder: &mut TargetRecorder<'_>,
) {
    let scoping = ctx.semantic.scoping();
    let empty_overrides = HashMap::new();
    for (sym, span, elements) in const_arrays {
        if scoping.get_resolved_references(*sym).next().is_none() {
            continue;
        }
        for elem in elements {
            match unwrap_transparent_expr(elem) {
                Expression::ObjectExpression(obj) => {
                    for prop in &obj.properties {
                        if let ObjectPropertyKind::ObjectProperty(entry) = prop
                            && let Some(EvalPath::Absolute(path)) =
                                eval_path_expr(&entry.value, ctx, &empty_overrides)
                        {
                            recorder.record_path(&path, *span);
                        }
                    }
                }
                other => {
                    if let Some(EvalPath::Absolute(path)) =
                        eval_path_expr(other, ctx, &empty_overrides)
                    {
                        recorder.record_path(&path, *span);
                    }
                }
            }
        }
    }
}
