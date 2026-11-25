//! Native static `fs` read, `child_process` local script, and `import.meta.glob` dependency
//! extraction.
//!
//! Files that neither import/require `fs`/`child_process` nor mention `import.meta.glob` return
//! immediately with zero AST traversal.

use crate::facts::{JsImportFact, JsImportKind, JsSpan, JsUncertainty};
use crate::file_discovery::{WorkspaceFileIndex, is_ignored_workspace_rel_path};
use crate::fs_bindings::{
    CHILD_PROCESS_EXEC_METHODS, FS_READ_METHODS, FsBindings, collect_module_bindings,
    is_child_process_ns_expr, is_fs_module_specifier, is_fs_ns_expr, is_fs_promises_expr,
};
use crate::fs_reads_helpers::{
    UnresolvedFsScan, record_unresolved_fs_reads, resolve_const_array_paths,
    resolve_helper_forwarded_calls,
};
use crate::fs_reads_prefix::{
    FS_DIR_PREFIX, extract_child_process_script_args, glob_pattern_dir_prefix,
    resolve_workspace_rel_even_if_missing,
};
use crate::meta_glob::{GlobExpandCtx, expand_meta_glob_call, is_import_meta_glob};
use crate::path_eval::{
    EvalPath, PathEvalCtx, eval_path_expr, ident_resolved_symbol, unwrap_transparent_expr,
};
use crate::spans::copied_span;
use oxc_ast::AstKind;
use oxc_ast::ast::{Argument, CallExpression, Expression};
use oxc_semantic::{NodeId, Semantic};
use oxc_span::Span;
use oxc_syntax::module_record::ModuleRecord;
use oxc_syntax::symbol::SymbolId;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

const MAX_DIR_EXPANSION_FILES: usize = 2_500;

pub(crate) struct TargetRecorder<'a> {
    current_path: &'a str,
    workspace_index: &'a WorkspaceFileIndex,
    targets: BTreeMap<String, JsSpan>,
    dir_targets: BTreeMap<String, JsSpan>,
}

impl TargetRecorder<'_> {
    pub(crate) fn record_path(&mut self, candidate: &Path, span: Span) -> bool {
        let Some(canonical_root) = self.workspace_index.canonical_root() else {
            return false;
        };
        if let Some(glob_dir) = glob_pattern_dir_prefix(candidate) {
            return self.record_dir_prefix(&glob_dir, span);
        }
        let Some((rel, is_dir)) = resolve_workspace_rel_even_if_missing(canonical_root, candidate)
        else {
            return false;
        };
        if is_ignored_workspace_rel_path(&rel) || rel.is_empty() || rel == "." {
            return false;
        }
        if is_dir {
            self.dir_targets
                .entry(rel.clone())
                .or_insert_with(|| copied_span(span));
            let files = self.workspace_index.files_under_dir(&rel);
            if !files.is_empty() && files.len() <= MAX_DIR_EXPANSION_FILES {
                for file_rel in files {
                    self.insert_target(file_rel.clone(), span);
                }
            }
            return true;
        }
        self.insert_target(rel, span);
        true
    }

    pub(crate) fn record_dir_prefix(&mut self, candidate: &Path, span: Span) -> bool {
        let Some(canonical_root) = self.workspace_index.canonical_root() else {
            return false;
        };
        let Some((rel, _)) = resolve_workspace_rel_even_if_missing(canonical_root, candidate)
        else {
            return false;
        };
        if is_ignored_workspace_rel_path(&rel) || rel.is_empty() || rel == "." {
            return false;
        }
        self.dir_targets
            .entry(rel)
            .or_insert_with(|| copied_span(span));
        true
    }

    fn insert_target(&mut self, rel: String, span: Span) {
        if rel != self.current_path {
            self.targets.entry(rel).or_insert_with(|| copied_span(span));
        }
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
) -> (Vec<JsImportFact>, Vec<JsUncertainty>) {
    if !may_contain_fs_or_glob(module_record, source) {
        return (Vec::new(), Vec::new());
    }
    let Some(file_dir) = absolute_path.parent() else {
        return (Vec::new(), Vec::new());
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
        targets: BTreeMap::new(),
        dir_targets: BTreeMap::new(),
    };
    let empty_overrides = HashMap::new();
    let mut saw_fs_read_call = false;
    let mut unresolved_calls: Vec<(NodeId, Span, &Expression<'_>)> = Vec::new();

    for node in semantic.nodes().iter() {
        let AstKind::CallExpression(call) = node.kind() else {
            continue;
        };
        if is_import_meta_glob(call) {
            expand_meta_glob_call(call, &glob_ctx, &mut recorder.targets);
            continue;
        }
        if is_child_process_exec_call(call, &collected.fs, semantic) {
            record_child_process_scripts(call, &eval_ctx, &empty_overrides, &mut recorder);
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
            Some(EvalPath::Absolute(resolved)) => {
                recorder.record_path(&resolved, call.span);
            }
            Some(EvalPath::Relative(rel)) => {
                recorder.record_path(&workspace_root.join(rel), call.span);
            }
            None => unresolved_calls.push((node.id(), call.span, arg0)),
        }
    }

    let resolved_by_helper =
        resolve_helper_forwarded_calls(&unresolved_calls, &eval_ctx, &mut recorder);
    let const_array_hits = if saw_fs_read_call {
        resolve_const_array_paths(&collected.const_arrays, &eval_ctx, &mut recorder)
    } else {
        0
    };
    let scan = UnresolvedFsScan {
        path,
        unresolved_calls: &unresolved_calls,
        resolved_by_helper: &resolved_by_helper,
        has_const_array_hits: const_array_hits > 0,
        ctx: &eval_ctx,
        empty_overrides: &empty_overrides,
    };
    let mut fs_uncertainties = Vec::new();
    record_unresolved_fs_reads(&scan, &mut recorder, &mut fs_uncertainties);

    let mut out: Vec<JsImportFact> = recorder
        .targets
        .into_iter()
        .map(|(resolved_path, span)| {
            make_asset_import(format!("fs:{resolved_path}"), resolved_path, span)
        })
        .collect();
    for (dir_rel, span) in recorder.dir_targets {
        let dir_node = format!("{FS_DIR_PREFIX}{dir_rel}");
        out.push(make_asset_import(dir_node.clone(), dir_node, span));
    }
    (out, fs_uncertainties)
}

fn make_asset_import(specifier: String, resolved_path: String, span: JsSpan) -> JsImportFact {
    JsImportFact {
        specifier,
        span,
        kind: JsImportKind::Asset,
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
            "'child_process'",
            "\"child_process\"",
            "'node:child_process'",
            "\"node:child_process\"",
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

fn is_child_process_exec_call(
    call: &CallExpression<'_>,
    fs: &FsBindings,
    semantic: &Semantic<'_>,
) -> bool {
    match unwrap_transparent_expr(&call.callee) {
        Expression::Identifier(ident) => ident_resolved_symbol(semantic, ident)
            .is_some_and(|sym| fs.direct_exec_syms.contains(&sym)),
        Expression::StaticMemberExpression(member) => {
            CHILD_PROCESS_EXEC_METHODS.contains(&member.property.name.as_str())
                && is_child_process_ns_expr(&member.object, fs, semantic)
        }
        _ => false,
    }
}

fn record_child_process_scripts<'a>(
    call: &'a CallExpression<'a>,
    ctx: &PathEvalCtx<'a>,
    empty_overrides: &HashMap<SymbolId, EvalPath>,
    recorder: &mut TargetRecorder<'_>,
) {
    for expr in extract_child_process_script_args(call) {
        let resolved = match eval_path_expr(expr, ctx, empty_overrides) {
            Some(EvalPath::Absolute(p)) => p,
            Some(EvalPath::Relative(rel)) if rel.to_string_lossy().contains('/') => {
                ctx.workspace_root.join(rel)
            }
            _ => continue,
        };
        if resolved.is_file() {
            recorder.record_path(&resolved, call.span);
        }
    }
}
