//! Local helper-forwarding, const-array path resolution, and unresolved dynamic `fs` uncertainty
//! attribution for `fs_reads`.

use crate::facts::JsUncertainty;
use crate::fs_reads::TargetRecorder;
use crate::fs_reads_prefix::{
    enclosing_for_of_literal_overrides, eval_static_dir_prefix, expr_originates_from_tmpdir,
};
use crate::path_eval::{
    EvalPath, PathEvalCtx, eval_path_expr, ident_resolved_symbol, unwrap_transparent_expr,
};
use crate::spans::copied_span;
use oxc_ast::AstKind;
use oxc_ast::ast::{Argument, BindingPattern, Expression, ObjectPropertyKind};
use oxc_semantic::{NodeId, Semantic};
use oxc_span::{GetSpan, Span};
use oxc_syntax::symbol::SymbolId;
use std::collections::HashMap;

pub(crate) struct UnresolvedFsScan<'a> {
    pub(crate) path: &'a str,
    pub(crate) unresolved_calls: &'a [(NodeId, Span, &'a Expression<'a>)],
    pub(crate) resolved_by_helper: &'a [bool],
    pub(crate) has_const_array_hits: bool,
    pub(crate) ctx: &'a PathEvalCtx<'a>,
    pub(crate) empty_overrides: &'a HashMap<SymbolId, EvalPath>,
}

pub(crate) fn record_unresolved_fs_reads(
    scan: &UnresolvedFsScan<'_>,
    recorder: &mut TargetRecorder<'_>,
    out: &mut Vec<JsUncertainty>,
) {
    for (idx, &(_, call_span, arg0)) in scan.unresolved_calls.iter().enumerate() {
        if scan.resolved_by_helper.get(idx).copied().unwrap_or(false) {
            continue;
        }
        if let Some(prefix) = eval_static_dir_prefix(arg0, scan.ctx, scan.empty_overrides) {
            let candidate = match prefix {
                EvalPath::Absolute(p) => p,
                EvalPath::Relative(rel) => scan.ctx.workspace_root.join(rel),
            };
            if recorder.record_dir_prefix(&candidate, call_span) {
                continue;
            }
        }
        if scan.has_const_array_hits && is_local_non_root_binding_expr(arg0, scan.ctx.semantic) {
            continue;
        }
        if expr_originates_from_tmpdir(arg0, scan.ctx, 0) {
            continue;
        }
        out.push(JsUncertainty {
            path: scan.path.to_owned(),
            code: "unresolved-fs-read".to_owned(),
            message: "Filesystem read path could not be resolved statically.".to_owned(),
            span: Some(copied_span(call_span)),
            position: None,
        });
    }
}

fn is_local_non_root_binding_expr(expr: &Expression<'_>, semantic: &Semantic<'_>) -> bool {
    let root = semantic.scoping().root_scope_id();
    match unwrap_transparent_expr(expr) {
        Expression::Identifier(ident) => ident_resolved_symbol(semantic, ident)
            .is_some_and(|sym| semantic.scoping().symbol_scope_id(sym) != root),
        Expression::StaticMemberExpression(member) => {
            is_local_non_root_binding_expr(&member.object, semantic)
        }
        _ => false,
    }
}

pub(crate) fn resolve_helper_forwarded_calls<'a>(
    unresolved_calls: &[(NodeId, Span, &'a Expression<'a>)],
    ctx: &PathEvalCtx<'a>,
    recorder: &mut TargetRecorder<'_>,
) -> Vec<bool> {
    let nodes = ctx.semantic.nodes();
    let scoping = ctx.semantic.scoping();
    let empty_overrides = HashMap::new();
    let mut resolved_flags = vec![false; unresolved_calls.len()];

    for (idx, &(call_node_id, _, fs_arg)) in unresolved_calls.iter().enumerate() {
        let Some((helper_node_id, helper_sym, param_syms)) =
            enclosing_helper_signature(ctx.semantic, call_node_id)
        else {
            continue;
        };
        let mut saw_call = false;
        let mut all_resolved = true;
        for reference in scoping.get_resolved_references(helper_sym) {
            if nodes
                .ancestor_ids(reference.node_id())
                .any(|anc| anc == helper_node_id)
            {
                continue;
            }
            let ref_node = nodes.get_node(reference.node_id());
            let AstKind::CallExpression(helper_call) =
                nodes.parent_node(reference.node_id()).kind()
            else {
                continue;
            };
            if helper_call.callee.span() != ref_node.span() {
                continue;
            }
            saw_call = true;
            let override_sets =
                expand_helper_call_overrides(helper_call, &param_syms, ctx, &empty_overrides);
            if override_sets.is_empty() {
                all_resolved = false;
                continue;
            }
            for overrides in override_sets {
                if !record_fs_arg_with_overrides(
                    fs_arg,
                    helper_call.span,
                    ctx,
                    &overrides,
                    recorder,
                ) {
                    all_resolved = false;
                }
            }
        }
        if saw_call && all_resolved && !is_symbol_exported_from_module(ctx.semantic, helper_sym) {
            resolved_flags[idx] = true;
        }
    }
    resolved_flags
}

fn record_fs_arg_with_overrides<'a>(
    fs_arg: &'a Expression<'a>,
    call_span: Span,
    ctx: &PathEvalCtx<'a>,
    overrides: &HashMap<SymbolId, EvalPath>,
    recorder: &mut TargetRecorder<'_>,
) -> bool {
    match eval_path_expr(fs_arg, ctx, overrides) {
        Some(EvalPath::Absolute(resolved)) => recorder.record_path(&resolved, call_span),
        Some(EvalPath::Relative(rel)) => {
            recorder.record_path(&ctx.workspace_root.join(rel), call_span)
        }
        None => {
            let expanded = expand_ident_const_init(fs_arg, ctx).unwrap_or(fs_arg);
            let Some(prefix) = eval_static_dir_prefix(expanded, ctx, overrides) else {
                return false;
            };
            let candidate = match prefix {
                EvalPath::Absolute(p) => p,
                EvalPath::Relative(rel) => ctx.workspace_root.join(rel),
            };
            recorder.record_dir_prefix(&candidate, call_span)
        }
    }
}

fn expand_ident_const_init<'a>(
    expr: &'a Expression<'a>,
    ctx: &PathEvalCtx<'a>,
) -> Option<&'a Expression<'a>> {
    let Expression::Identifier(ident) = unwrap_transparent_expr(expr) else {
        return None;
    };
    let sym = ident_resolved_symbol(ctx.semantic, ident)?;
    ctx.bindings.const_inits.get(&sym).copied()
}

fn expand_helper_call_overrides<'a>(
    helper_call: &'a oxc_ast::ast::CallExpression<'a>,
    param_syms: &[Option<SymbolId>],
    ctx: &PathEvalCtx<'a>,
    empty_overrides: &HashMap<SymbolId, EvalPath>,
) -> Vec<HashMap<SymbolId, EvalPath>> {
    let loop_sets = enclosing_for_of_literal_overrides(helper_call, ctx);
    let env_list: Vec<HashMap<SymbolId, EvalPath>> = if loop_sets.is_empty() {
        vec![empty_overrides.clone()]
    } else {
        loop_sets
    };
    let mut results = Vec::new();
    for env in &env_list {
        let mut overrides = HashMap::new();
        for (p_idx, param_sym) in param_syms.iter().enumerate() {
            if let Some(sym) = param_sym
                && let Some(arg_expr) = helper_call
                    .arguments
                    .get(p_idx)
                    .and_then(Argument::as_expression)
                && let Some(val) = eval_path_expr(arg_expr, ctx, env)
            {
                overrides.insert(*sym, val);
            }
        }
        if !overrides.is_empty() {
            results.push(overrides);
        }
    }
    results
}

fn is_symbol_exported_from_module(semantic: &Semantic<'_>, sym: SymbolId) -> bool {
    let nodes = semantic.nodes();
    semantic.scoping().symbol_declarations(sym).any(|decl_id| {
        nodes.ancestor_ids(decl_id).any(|anc| {
            matches!(
                nodes.get_node(anc).kind(),
                AstKind::ExportNamedDeclaration(_) | AstKind::ExportDefaultDeclaration(_)
            )
        })
    })
}

fn enclosing_helper_signature(
    semantic: &Semantic<'_>,
    node_id: NodeId,
) -> Option<(NodeId, SymbolId, Vec<Option<SymbolId>>)> {
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
                return Some((ancestor_id, helper_sym, params));
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
                return Some((ancestor_id, helper_sym, params));
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

pub(crate) fn resolve_const_array_paths<'a>(
    const_arrays: &[(SymbolId, Span, Vec<&'a Expression<'a>>)],
    ctx: &PathEvalCtx<'a>,
    recorder: &mut TargetRecorder<'_>,
) -> usize {
    let scoping = ctx.semantic.scoping();
    let empty_overrides = HashMap::new();
    let mut hits = 0;
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
                            && recorder.record_path(&path, *span)
                        {
                            hits += 1;
                        }
                    }
                }
                other => {
                    if let Some(EvalPath::Absolute(path)) =
                        eval_path_expr(other, ctx, &empty_overrides)
                        && recorder.record_path(&path, *span)
                    {
                        hits += 1;
                    }
                }
            }
        }
    }
    hits
}
