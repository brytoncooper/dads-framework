//! Static directory-prefix extraction, missing-at-baseline path normalization, and `child_process`
//! local script argument extraction for `fs_reads`.

use crate::path_eval::{
    EvalPath, PathEvalCtx, eval_path_expr, ident_resolved_symbol, unwrap_transparent_expr,
};
use crate::workspace::{normalize_lexical, workspace_relative_path};
use oxc_ast::AstKind;
use oxc_ast::ast::{
    Argument, BindingPattern, CallExpression, Expression, ForStatementLeft, TemplateLiteral,
};
use oxc_syntax::operator::BinaryOperator;
use oxc_syntax::symbol::SymbolId;
use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

pub(crate) const FS_DIR_PREFIX: &str = "fs-dir:";

/// Resolves `candidate` to `(workspace_relative_path, is_dir)`.
///
/// When `candidate` does not exist yet on disk (for example `existsSync("settings/sentinel.json")`
/// before a PR creates that file), canonicalizes the nearest existing ancestor inside
/// `canonical_root` and appends the remaining safe lexical tail so creating the file later
/// invalidates both planning and receipt caches.
pub(crate) fn resolve_workspace_rel_even_if_missing(
    canonical_root: &Path,
    candidate: &Path,
) -> Option<(String, bool)> {
    let normalized = normalize_lexical(candidate);
    match normalized.canonicalize() {
        Ok(canonical_target) => {
            if !canonical_target.starts_with(canonical_root) {
                return None;
            }
            let rel = workspace_relative_path(canonical_root, &canonical_target)?;
            Some((rel, canonical_target.is_dir()))
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {
            let mut tail = Vec::new();
            let mut cursor = normalized.as_path();
            loop {
                if let Ok(canon_ancestor) = cursor.canonicalize() {
                    if !canon_ancestor.starts_with(canonical_root) {
                        return None;
                    }
                    let mut joined = canon_ancestor;
                    for segment in tail.into_iter().rev() {
                        joined.push(segment);
                    }
                    let rel = workspace_relative_path(canonical_root, &joined)?;
                    return (!rel.is_empty() && rel != ".").then_some((rel, false));
                }
                let file_name = cursor.file_name()?;
                let name_str = file_name.to_str()?;
                if name_str.is_empty() || name_str == "." || name_str == ".." {
                    return None;
                }
                tail.push(name_str.to_owned());
                cursor = cursor.parent()?;
            }
        }
        Err(_) => None,
    }
}

/// Extracts the deepest leading static directory prefix from a dynamic path expression such as
/// `path.join(FIXTURE_DIR, name)`, `path.resolve(__dirname, "../fixtures", name)`,
/// `` `${FIXTURE_DIR}/${name}` ``, or `FIXTURE_DIR + "/" + name`.
pub(crate) fn eval_static_dir_prefix<'a>(
    expr: &'a Expression<'a>,
    ctx: &PathEvalCtx<'a>,
    overrides: &HashMap<SymbolId, EvalPath>,
) -> Option<EvalPath> {
    match unwrap_transparent_expr(expr) {
        Expression::CallExpression(call) => eval_call_dir_prefix(call, ctx, overrides),
        Expression::TemplateLiteral(tpl) => eval_template_dir_prefix(tpl, ctx, overrides),
        Expression::BinaryExpression(bin) if bin.operator == BinaryOperator::Addition => {
            eval_path_expr(&bin.left, ctx, overrides)
        }
        _ => None,
    }
}

fn eval_call_dir_prefix<'a>(
    call: &'a CallExpression<'a>,
    ctx: &PathEvalCtx<'a>,
    overrides: &HashMap<SymbolId, EvalPath>,
) -> Option<EvalPath> {
    let method = path_join_or_resolve_method(call, ctx)?;
    let mut parts = Vec::new();
    for arg in &call.arguments {
        let Some(expr) = arg.as_expression() else {
            break;
        };
        let Some(val) = eval_path_expr(expr, ctx, overrides) else {
            break;
        };
        parts.push(val);
    }
    if parts.is_empty() || parts.len() == call.arguments.len() {
        return None;
    }
    if method == "resolve" {
        let mut acc: Option<PathBuf> = None;
        let mut is_abs = false;
        for part in parts {
            match part {
                EvalPath::Absolute(p) => {
                    acc = Some(p);
                    is_abs = true;
                }
                EvalPath::Relative(p) => {
                    acc = Some(match acc {
                        Some(cur) => cur.join(p),
                        None => p,
                    });
                }
            }
        }
        let resolved = if is_abs {
            normalize_lexical(&acc?)
        } else {
            normalize_lexical(&ctx.workspace_root.join(acc?))
        };
        return Some(EvalPath::Absolute(resolved));
    }
    let is_abs = matches!(parts.first(), Some(EvalPath::Absolute(_)));
    let mut iter = parts.into_iter();
    let mut acc = iter.next()?.into_path();
    for seg in iter {
        let text = seg.as_path().to_string_lossy();
        let trimmed = text.trim_start_matches(['/', '\\']);
        if !trimmed.is_empty() {
            acc.push(trimmed);
        }
    }
    let normalized = normalize_lexical(&acc);
    Some(if is_abs {
        EvalPath::Absolute(normalized)
    } else {
        EvalPath::Relative(normalized)
    })
}

fn eval_template_dir_prefix<'a>(
    tpl: &'a TemplateLiteral<'a>,
    ctx: &PathEvalCtx<'a>,
    overrides: &HashMap<SymbolId, EvalPath>,
) -> Option<EvalPath> {
    let mut combined = String::new();
    let mut is_abs = false;
    let mut stopped_early = false;
    for (idx, quasi) in tpl.quasis.iter().enumerate() {
        let chunk = quasi
            .value
            .cooked
            .as_deref()
            .unwrap_or(quasi.value.raw.as_str());
        combined.push_str(chunk);
        if let Some(expr) = tpl.expressions.get(idx) {
            if let Some(val) = eval_path_expr(expr, ctx, overrides) {
                if combined.is_empty() && matches!(val, EvalPath::Absolute(_)) {
                    is_abs = true;
                }
                combined.push_str(&val.as_path().to_string_lossy());
            } else {
                stopped_early = true;
                break;
            }
        }
    }
    if !stopped_early || combined.is_empty() {
        return None;
    }
    let trimmed = combined.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    Some(if is_abs || path.is_absolute() {
        EvalPath::Absolute(normalize_lexical(&path))
    } else {
        EvalPath::Relative(normalize_lexical(&path))
    })
}

fn path_join_or_resolve_method(
    call: &CallExpression<'_>,
    ctx: &PathEvalCtx<'_>,
) -> Option<&'static str> {
    match unwrap_transparent_expr(&call.callee) {
        Expression::Identifier(ident) => {
            let ref_id = ident.reference_id.get()?;
            let sym = ctx.semantic.scoping().get_reference(ref_id).symbol_id()?;
            if ctx.bindings.join_syms.contains(&sym) {
                Some("join")
            } else if ctx.bindings.resolve_syms.contains(&sym) {
                Some("resolve")
            } else {
                None
            }
        }
        Expression::StaticMemberExpression(member) => {
            let method = match member.property.name.as_str() {
                "join" => "join",
                "resolve" => "resolve",
                _ => return None,
            };
            let is_path_ns = match unwrap_transparent_expr(&member.object) {
                Expression::Identifier(ident) => ident
                    .reference_id
                    .get()
                    .and_then(|r| ctx.semantic.scoping().get_reference(r).symbol_id())
                    .is_some_and(|sym| ctx.bindings.path_ns_syms.contains(&sym)),
                _ => false,
            };
            is_path_ns.then_some(method)
        }
        _ => None,
    }
}

/// Extracts a literal directory prefix from a glob pattern passed to `fs.globSync(pattern)` or
/// `fs.glob(pattern)`.
pub(crate) fn glob_pattern_dir_prefix(pattern: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    let mut saw_glob = false;
    for comp in pattern.components() {
        match comp {
            Component::Normal(seg) => {
                let s = seg.to_string_lossy();
                if s.contains('*') || s.contains('?') || s.contains('[') || s.contains('{') {
                    saw_glob = true;
                    break;
                }
                out.push(seg);
            }
            other => out.push(other.as_os_str()),
        }
    }
    (saw_glob && !out.as_os_str().is_empty()).then_some(out)
}

/// Extracts candidate local script path expressions from `execFileSync(file, [args...])` and
/// `spawnSync(cmd, [args...])`.
pub(crate) fn extract_child_process_script_args<'a>(
    call: &'a CallExpression<'a>,
) -> Vec<&'a Expression<'a>> {
    let mut out = Vec::new();
    if let Some(arg0) = call.arguments.first().and_then(Argument::as_expression) {
        out.push(arg0);
    }
    if let Some(arg1) = call.arguments.get(1).and_then(Argument::as_expression)
        && let Expression::ArrayExpression(arr) = unwrap_transparent_expr(arg1)
    {
        for el in &arr.elements {
            if let Some(expr) = el.as_expression() {
                out.push(expr);
            }
        }
    }
    out
}

pub(crate) fn expr_originates_from_tmpdir(
    expr: &Expression<'_>,
    ctx: &PathEvalCtx<'_>,
    depth: u8,
) -> bool {
    if depth > 6 {
        return false;
    }
    match unwrap_transparent_expr(expr) {
        Expression::CallExpression(call) => {
            let is_tmp_call = match unwrap_transparent_expr(&call.callee) {
                Expression::Identifier(ident) => {
                    matches!(ident.name.as_str(), "tmpdir" | "mkdtempSync" | "mkdtemp")
                }
                Expression::StaticMemberExpression(member) => matches!(
                    member.property.name.as_str(),
                    "tmpdir" | "mkdtempSync" | "mkdtemp"
                ),
                _ => false,
            };
            is_tmp_call
                || call
                    .arguments
                    .first()
                    .and_then(Argument::as_expression)
                    .is_some_and(|first| expr_originates_from_tmpdir(first, ctx, depth + 1))
        }
        Expression::AwaitExpression(aw) => {
            expr_originates_from_tmpdir(&aw.argument, ctx, depth + 1)
        }
        Expression::Identifier(ident) => ident_resolved_symbol(ctx.semantic, ident)
            .and_then(|sym| ctx.bindings.const_inits.get(&sym))
            .is_some_and(|init| expr_originates_from_tmpdir(init, ctx, depth + 1)),
        Expression::TemplateLiteral(tpl) => tpl
            .expressions
            .first()
            .is_some_and(|first| expr_originates_from_tmpdir(first, ctx, depth + 1)),
        Expression::BinaryExpression(bin) => expr_originates_from_tmpdir(&bin.left, ctx, depth + 1),
        _ => false,
    }
}

pub(crate) fn enclosing_for_of_literal_overrides(
    helper_call: &CallExpression<'_>,
    ctx: &PathEvalCtx<'_>,
) -> Vec<HashMap<SymbolId, EvalPath>> {
    let nodes = ctx.semantic.nodes();
    let Some(call_node) = nodes
        .iter()
        .find(|n| matches!(n.kind(), AstKind::CallExpression(c) if c.span == helper_call.span))
    else {
        return Vec::new();
    };
    for anc in nodes.ancestor_ids(call_node.id()) {
        let AstKind::ForOfStatement(for_of) = nodes.get_node(anc).kind() else {
            continue;
        };
        let ForStatementLeft::VariableDeclaration(var_decl) = &for_of.left else {
            continue;
        };
        let Some(decl) = var_decl.declarations.first() else {
            continue;
        };
        let BindingPattern::BindingIdentifier(ident) = &decl.id else {
            continue;
        };
        let Some(loop_sym) = ident.symbol_id.get() else {
            continue;
        };
        let right_expr = match unwrap_transparent_expr(&for_of.right) {
            Expression::Identifier(id) => ident_resolved_symbol(ctx.semantic, id)
                .and_then(|sym| ctx.bindings.const_inits.get(&sym).copied())
                .map(unwrap_transparent_expr)
                .unwrap_or(&for_of.right),
            other => other,
        };
        let Expression::ArrayExpression(arr) = right_expr else {
            continue;
        };
        let mut sets = Vec::new();
        for elem in &arr.elements {
            if let Some(Expression::StringLiteral(lit)) =
                elem.as_expression().map(unwrap_transparent_expr)
            {
                let mut m = HashMap::new();
                m.insert(
                    loop_sym,
                    EvalPath::Relative(PathBuf::from(lit.value.as_str())),
                );
                sets.push(m);
            }
        }
        if !sets.is_empty() {
            return sets;
        }
    }
    Vec::new()
}
