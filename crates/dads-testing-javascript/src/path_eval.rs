//! Bounded intra-file constant path expression evaluator used by `fs_reads` to resolve static
//! filesystem targets (`path.join`, `path.resolve`, `new URL(..., import.meta.url)`, `__dirname`,
//! `import.meta.dirname`, `fileURLToPath`, `dirname`, `process.cwd()`, and `const` bindings).

use crate::fs_bindings::PathBindings;
use crate::workspace::normalize_lexical;
use oxc_ast::ast::{
    CallExpression, Expression, IdentifierReference, NewExpression, StaticMemberExpression,
    TemplateLiteral,
};
use oxc_semantic::Semantic;
use oxc_syntax::operator::BinaryOperator;
use oxc_syntax::symbol::SymbolId;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

const MAX_PATH_EVAL_DEPTH: u8 = 8;

/// Distinguishes explicitly rooted paths (`__dirname`, `import.meta.dirname`, `import.meta.url`,
/// `process.cwd()`, `path.resolve`, or absolute paths) from bare relative string fragments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum EvalPath {
    Absolute(PathBuf),
    Relative(PathBuf),
}

impl EvalPath {
    pub(crate) fn into_path(self) -> PathBuf {
        match self {
            Self::Absolute(path) | Self::Relative(path) => path,
        }
    }

    pub(crate) fn as_path(&self) -> &Path {
        match self {
            Self::Absolute(path) | Self::Relative(path) => path.as_path(),
        }
    }
}

pub(crate) struct PathEvalCtx<'a> {
    pub(crate) semantic: &'a Semantic<'a>,
    pub(crate) workspace_root: &'a Path,
    pub(crate) file_path: &'a Path,
    pub(crate) file_dir: &'a Path,
    pub(crate) bindings: &'a PathBindings<'a>,
}

struct EvalState<'a, 'b> {
    ctx: &'b PathEvalCtx<'a>,
    overrides: &'b HashMap<SymbolId, EvalPath>,
    visited: HashSet<SymbolId>,
}

pub(crate) fn unwrap_transparent_expr<'a>(mut expr: &'a Expression<'a>) -> &'a Expression<'a> {
    loop {
        match expr {
            Expression::ParenthesizedExpression(inner) => expr = &inner.expression,
            Expression::TSAsExpression(inner) => expr = &inner.expression,
            Expression::TSSatisfiesExpression(inner) => expr = &inner.expression,
            Expression::TSNonNullExpression(inner) => expr = &inner.expression,
            Expression::TSTypeAssertion(inner) => expr = &inner.expression,
            _ => return expr,
        }
    }
}

pub(crate) fn ident_resolved_symbol(
    semantic: &Semantic<'_>,
    ident: &IdentifierReference<'_>,
) -> Option<SymbolId> {
    let ref_id = ident.reference_id.get()?;
    semantic.scoping().get_reference(ref_id).symbol_id()
}

pub(crate) fn is_import_meta(expr: &Expression<'_>) -> bool {
    matches!(unwrap_transparent_expr(expr), Expression::ImportMeta(_))
}

pub(crate) fn eval_path_expr<'a>(
    expr: &'a Expression<'a>,
    ctx: &PathEvalCtx<'a>,
    overrides: &HashMap<SymbolId, EvalPath>,
) -> Option<EvalPath> {
    let mut state = EvalState {
        ctx,
        overrides,
        visited: HashSet::new(),
    };
    state.eval(expr, 0)
}

impl<'a> EvalState<'a, '_> {
    fn eval(&mut self, expr: &'a Expression<'a>, depth: u8) -> Option<EvalPath> {
        if depth > MAX_PATH_EVAL_DEPTH {
            return None;
        }
        match unwrap_transparent_expr(expr) {
            Expression::StringLiteral(lit) => Some(wrap_eval_path(lit.value.as_str(), false)),
            Expression::TemplateLiteral(tpl) => self.eval_template(tpl, depth),
            Expression::BinaryExpression(bin) if bin.operator == BinaryOperator::Addition => {
                let left = self.eval(&bin.left, depth + 1)?;
                let right = self.eval(&bin.right, depth + 1)?;
                let combined = format!(
                    "{}{}",
                    left.as_path().to_string_lossy(),
                    right.as_path().to_string_lossy()
                );
                Some(wrap_eval_path(
                    &combined,
                    matches!(left, EvalPath::Absolute(_)),
                ))
            }
            Expression::Identifier(ident) => self.eval_ident(ident, depth),
            Expression::StaticMemberExpression(member) => self.eval_member(member, depth),
            Expression::NewExpression(new_expr) => self.eval_new_url(new_expr, depth),
            Expression::CallExpression(call) => self.eval_call(call, depth),
            _ => None,
        }
    }

    fn eval_template(&mut self, tpl: &'a TemplateLiteral<'a>, depth: u8) -> Option<EvalPath> {
        let mut combined = String::new();
        let mut prefer_absolute = false;
        for (idx, quasi) in tpl.quasis.iter().enumerate() {
            let chunk = quasi
                .value
                .cooked
                .as_deref()
                .unwrap_or(quasi.value.raw.as_str());
            combined.push_str(chunk);
            if let Some(expr) = tpl.expressions.get(idx) {
                let value = self.eval(expr, depth + 1)?;
                if combined.is_empty() && matches!(value, EvalPath::Absolute(_)) {
                    prefer_absolute = true;
                }
                combined.push_str(&value.as_path().to_string_lossy());
            }
        }
        Some(wrap_eval_path(&combined, prefer_absolute))
    }

    fn eval_ident(&mut self, ident: &IdentifierReference<'_>, depth: u8) -> Option<EvalPath> {
        if let Some(sym) = ident_resolved_symbol(self.ctx.semantic, ident) {
            if let Some(value) = self.overrides.get(&sym) {
                return Some(value.clone());
            }
            if let Some(init) = self.ctx.bindings.const_inits.get(&sym)
                && self.visited.insert(sym)
            {
                let value = self.eval(init, depth + 1);
                self.visited.remove(&sym);
                return value;
            }
        }
        match ident.name.as_str() {
            "__dirname" => Some(EvalPath::Absolute(self.ctx.file_dir.to_path_buf())),
            "__filename" => Some(EvalPath::Absolute(self.ctx.file_path.to_path_buf())),
            _ => None,
        }
    }

    fn eval_member(
        &mut self,
        member: &'a StaticMemberExpression<'a>,
        depth: u8,
    ) -> Option<EvalPath> {
        if is_import_meta(&member.object) {
            return match member.property.name.as_str() {
                "dirname" => Some(EvalPath::Absolute(self.ctx.file_dir.to_path_buf())),
                "filename" | "url" => Some(EvalPath::Absolute(self.ctx.file_path.to_path_buf())),
                _ => None,
            };
        }
        if member.property.name.as_str() == "pathname" {
            let base = self.eval(&member.object, depth + 1)?;
            return matches!(base, EvalPath::Absolute(_)).then_some(base);
        }
        None
    }

    fn eval_new_url(&mut self, new_expr: &'a NewExpression<'a>, depth: u8) -> Option<EvalPath> {
        if !is_url_constructor(&new_expr.callee) {
            return None;
        }
        match new_expr.arguments.as_slice() {
            [first] => {
                let value = self.eval(first.as_expression()?, depth + 1)?;
                matches!(value, EvalPath::Absolute(_)).then_some(value)
            }
            [first, second] => {
                let rel = self.eval(first.as_expression()?, depth + 1)?;
                let base_expr = second.as_expression()?;
                let base_dir = if is_import_meta_url(base_expr) {
                    self.ctx.file_dir.to_path_buf()
                } else {
                    let EvalPath::Absolute(base_path) = self.eval(base_expr, depth + 1)? else {
                        return None;
                    };
                    if base_path.is_dir() {
                        base_path
                    } else {
                        base_path.parent()?.to_path_buf()
                    }
                };
                let resolved = match rel {
                    EvalPath::Absolute(abs) => normalize_lexical(&abs),
                    EvalPath::Relative(part) => normalize_lexical(&base_dir.join(part)),
                };
                Some(EvalPath::Absolute(resolved))
            }
            _ => None,
        }
    }

    fn eval_call(&mut self, call: &'a CallExpression<'a>, depth: u8) -> Option<EvalPath> {
        if is_process_cwd_call(call) {
            return Some(EvalPath::Absolute(self.ctx.workspace_root.to_path_buf()));
        }
        if is_file_url_to_path_call(call, self.ctx) {
            return self.eval(call.arguments.first()?.as_expression()?, depth + 1);
        }
        if is_path_fn_call(call, self.ctx, &self.ctx.bindings.dirname_syms, "dirname") {
            let value = self.eval(call.arguments.first()?.as_expression()?, depth + 1)?;
            let is_abs = matches!(value, EvalPath::Absolute(_));
            let parent = normalize_lexical(value.as_path()).parent()?.to_path_buf();
            return Some(if is_abs {
                EvalPath::Absolute(parent)
            } else {
                EvalPath::Relative(parent)
            });
        }
        if is_path_fn_call(call, self.ctx, &self.ctx.bindings.join_syms, "join") {
            return self.eval_join(call, depth);
        }
        if is_path_fn_call(call, self.ctx, &self.ctx.bindings.resolve_syms, "resolve") {
            return self.eval_resolve(call, depth);
        }
        None
    }

    fn eval_join(&mut self, call: &'a CallExpression<'a>, depth: u8) -> Option<EvalPath> {
        if call.arguments.is_empty() {
            return None;
        }
        let mut parts = Vec::with_capacity(call.arguments.len());
        for arg in &call.arguments {
            parts.push(self.eval(arg.as_expression()?, depth + 1)?);
        }
        let is_abs = matches!(parts.first(), Some(EvalPath::Absolute(_)));
        let mut iter = parts.into_iter();
        let mut acc = iter.next()?.into_path();
        for segment in iter {
            let text = segment.as_path().to_string_lossy();
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

    fn eval_resolve(&mut self, call: &'a CallExpression<'a>, depth: u8) -> Option<EvalPath> {
        let mut acc: Option<PathBuf> = None;
        let mut is_abs = false;
        for arg in &call.arguments {
            match self.eval(arg.as_expression()?, depth + 1)? {
                EvalPath::Absolute(path) => {
                    acc = Some(path);
                    is_abs = true;
                }
                EvalPath::Relative(part) => {
                    acc = Some(match acc {
                        Some(current) => current.join(part),
                        None => part,
                    });
                }
            }
        }
        let resolved = if is_abs {
            normalize_lexical(&acc?)
        } else {
            normalize_lexical(&self.ctx.workspace_root.join(acc.unwrap_or_default()))
        };
        Some(EvalPath::Absolute(resolved))
    }
}

fn wrap_eval_path(raw: &str, prefer_absolute: bool) -> EvalPath {
    if let Some(rest) = raw.strip_prefix("file://") {
        return EvalPath::Absolute(PathBuf::from(decode_percent_path(rest)));
    }
    let path = PathBuf::from(raw);
    if prefer_absolute || path.is_absolute() {
        EvalPath::Absolute(path)
    } else {
        EvalPath::Relative(path)
    }
}

fn is_import_meta_url(expr: &Expression<'_>) -> bool {
    matches!(
        unwrap_transparent_expr(expr),
        Expression::StaticMemberExpression(member)
            if is_import_meta(&member.object)
                && matches!(member.property.name.as_str(), "url" | "filename")
    )
}

fn is_url_constructor(expr: &Expression<'_>) -> bool {
    match unwrap_transparent_expr(expr) {
        Expression::Identifier(ident) => ident.name.as_str() == "URL",
        Expression::StaticMemberExpression(member) => {
            member.property.name.as_str() == "URL"
                && matches!(
                    unwrap_transparent_expr(&member.object),
                    Expression::Identifier(ident) if ident.name.as_str() == "globalThis"
                )
        }
        _ => false,
    }
}

fn is_process_cwd_call(call: &CallExpression<'_>) -> bool {
    call.arguments.is_empty()
        && matches!(
            unwrap_transparent_expr(&call.callee),
            Expression::StaticMemberExpression(member)
                if member.property.name.as_str() == "cwd"
                    && matches!(
                        unwrap_transparent_expr(&member.object),
                        Expression::Identifier(ident) if ident.name.as_str() == "process"
                    )
        )
}

fn is_file_url_to_path_call(call: &CallExpression<'_>, ctx: &PathEvalCtx<'_>) -> bool {
    match unwrap_transparent_expr(&call.callee) {
        Expression::Identifier(ident) => ident_resolved_symbol(ctx.semantic, ident)
            .is_some_and(|sym| ctx.bindings.file_url_to_path_syms.contains(&sym)),
        Expression::StaticMemberExpression(member) => {
            member.property.name.as_str() == "fileURLToPath"
                && matches!(
                    unwrap_transparent_expr(&member.object),
                    Expression::Identifier(ident)
                        if ident_resolved_symbol(ctx.semantic, ident)
                            .is_some_and(|sym| ctx.bindings.url_ns_syms.contains(&sym))
                )
        }
        _ => false,
    }
}

fn is_path_ns_expr(expr: &Expression<'_>, ctx: &PathEvalCtx<'_>) -> bool {
    match unwrap_transparent_expr(expr) {
        Expression::Identifier(ident) => ident_resolved_symbol(ctx.semantic, ident)
            .is_some_and(|sym| ctx.bindings.path_ns_syms.contains(&sym)),
        Expression::StaticMemberExpression(member) => {
            member.property.name.as_str() == "posix" && is_path_ns_expr(&member.object, ctx)
        }
        _ => false,
    }
}

fn is_path_fn_call(
    call: &CallExpression<'_>,
    ctx: &PathEvalCtx<'_>,
    direct_syms: &HashSet<SymbolId>,
    method: &str,
) -> bool {
    match unwrap_transparent_expr(&call.callee) {
        Expression::Identifier(ident) => {
            ident_resolved_symbol(ctx.semantic, ident).is_some_and(|sym| direct_syms.contains(&sym))
        }
        Expression::StaticMemberExpression(member) => {
            member.property.name.as_str() == method && is_path_ns_expr(&member.object, ctx)
        }
        _ => false,
    }
}

fn decode_percent_path(input: &str) -> String {
    if !input.contains('%') {
        return input.to_owned();
    }
    let bytes = input.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (hex_nibble(bytes[i + 1]), hex_nibble(bytes[i + 2]))
        {
            decoded.push((hi << 4) | lo);
            i += 3;
            continue;
        }
        decoded.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(decoded).unwrap_or_else(|_| input.to_owned())
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
