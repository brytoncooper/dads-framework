//! Purity checks for top-level expressions, classes, and pure declarations used by
//! intra-file def-use analysis and load-time side-effect classification.

use crate::intra_file_purity_checks::{
    binary_is_pure, identifier_is_tdz_safe, is_pure_builtin_call, is_pure_builtin_new,
    template_is_pure, unary_is_pure,
};
use oxc_ast::ast::{
    Argument, ArrayExpressionElement, BindingPattern, CallExpression, Class, ClassElement,
    Declaration, ExportDefaultDeclarationKind, Expression, ObjectPropertyKind,
};
use oxc_semantic::Semantic;
use oxc_span::{GetSpan, Span};
use oxc_syntax::symbol::SymbolId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum DeclNode {
    Symbol(SymbolId),
    DefaultExport,
    EffectfulStmt(usize),
    TypeOnlyStmt(usize),
}

pub(crate) struct PurityContext<'a> {
    pub(crate) semantic: &'a Semantic<'a>,
    pub(crate) pure_factories: &'a [String],
}

pub(crate) fn record_pure_default_export(
    kind: &ExportDefaultDeclarationKind<'_>,
    statement_span: Span,
    ctx: &PurityContext<'_>,
    out: &mut Vec<(Span, DeclNode)>,
) -> Option<()> {
    match kind {
        ExportDefaultDeclarationKind::FunctionDeclaration(func) => {
            let node = func
                .id
                .as_ref()
                .and_then(|id| find_root_symbol(ctx.semantic, id.name.as_str(), id.span))
                .map_or(DeclNode::DefaultExport, DeclNode::Symbol);
            out.push((statement_span, node));
            Some(())
        }
        ExportDefaultDeclarationKind::ClassDeclaration(class) => {
            if !class_is_pure(class, ctx) {
                return None;
            }
            let node = class
                .id
                .as_ref()
                .and_then(|id| find_root_symbol(ctx.semantic, id.name.as_str(), id.span))
                .map_or(DeclNode::DefaultExport, DeclNode::Symbol);
            out.push((statement_span, node));
            Some(())
        }
        ExportDefaultDeclarationKind::TSInterfaceDeclaration(_) => Some(()),
        other => {
            let expr = other.as_expression()?;
            if !expr_is_pure(expr, ctx) {
                return None;
            }
            out.push((statement_span, DeclNode::DefaultExport));
            Some(())
        }
    }
}

pub(crate) fn record_pure_declaration(
    decl: &Declaration<'_>,
    ctx: &PurityContext<'_>,
    out: &mut Vec<(Span, DeclNode)>,
) -> Option<()> {
    match decl {
        Declaration::FunctionDeclaration(func) => {
            let id = func.id.as_ref()?;
            let sym = find_root_symbol(ctx.semantic, id.name.as_str(), id.span)?;
            out.push((func.span, DeclNode::Symbol(sym)));
            Some(())
        }
        Declaration::ClassDeclaration(class) => {
            if !class_is_pure(class, ctx) {
                return None;
            }
            let id = class.id.as_ref()?;
            let sym = find_root_symbol(ctx.semantic, id.name.as_str(), id.span)?;
            out.push((class.span, DeclNode::Symbol(sym)));
            Some(())
        }
        Declaration::VariableDeclaration(var_decl) => {
            for declarator in &var_decl.declarations {
                let BindingPattern::BindingIdentifier(ident) = &declarator.id else {
                    return None;
                };
                if let Some(init) = &declarator.init
                    && !expr_is_pure(init, ctx)
                {
                    return None;
                }
                let sym = find_root_symbol(ctx.semantic, ident.name.as_str(), ident.span)?;
                out.push((declarator.span, DeclNode::Symbol(sym)));
            }
            Some(())
        }
        Declaration::TSTypeAliasDeclaration(alias) => {
            if let Some(sym) = find_root_symbol(ctx.semantic, alias.id.name.as_str(), alias.id.span)
            {
                out.push((alias.span, DeclNode::Symbol(sym)));
            }
            Some(())
        }
        Declaration::TSInterfaceDeclaration(iface) => {
            if let Some(sym) = find_root_symbol(ctx.semantic, iface.id.name.as_str(), iface.id.span)
            {
                out.push((iface.span, DeclNode::Symbol(sym)));
            }
            Some(())
        }
        _ => None,
    }
}

pub(crate) fn find_root_symbol(
    semantic: &Semantic<'_>,
    name: &str,
    span: Span,
) -> Option<SymbolId> {
    let scoping = semantic.scoping();
    let root_scope = scoping.root_scope_id();
    scoping.symbol_ids().find(|sym| {
        scoping.symbol_scope_id(*sym) == root_scope
            && scoping.symbol_name(*sym) == name
            && (scoping.symbol_span(*sym) == span
                || scoping.symbol_declarations(*sym).any(|node_id| {
                    let node_span = semantic.nodes().get_node(node_id).span();
                    node_span == span
                        || (node_span.start <= span.start && span.end <= node_span.end)
                }))
    })
}

pub(crate) fn class_is_pure(class: &Class<'_>, ctx: &PurityContext<'_>) -> bool {
    if !class.decorators.is_empty() || class.heritage.is_some() {
        return false;
    }
    class.body.body.iter().all(|element| match element {
        ClassElement::StaticBlock(_) => false,
        ClassElement::PropertyDefinition(prop) => {
            prop.decorators.is_empty()
                && !prop.computed
                && (!prop.r#static || prop.value.as_ref().is_none_or(|e| expr_is_pure(e, ctx)))
        }
        ClassElement::MethodDefinition(method) => method.decorators.is_empty() && !method.computed,
        ClassElement::AccessorProperty(prop) => {
            prop.decorators.is_empty()
                && !prop.computed
                && (!prop.r#static || prop.value.as_ref().is_none_or(|e| expr_is_pure(e, ctx)))
        }
        ClassElement::TSIndexSignature(_) => true,
    })
}

pub(crate) fn expr_is_pure(expr: &Expression<'_>, ctx: &PurityContext<'_>) -> bool {
    match expr {
        Expression::ArrowFunctionExpression(_)
        | Expression::FunctionExpression(_)
        | Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::BigIntLiteral(_)
        | Expression::RegExpLiteral(_)
        | Expression::StringLiteral(_) => true,
        Expression::Identifier(ident) => identifier_is_tdz_safe(ident, ctx.semantic),
        Expression::ClassExpression(class) => class_is_pure(class, ctx),
        Expression::TemplateLiteral(tpl) => template_is_pure(tpl, ctx),
        Expression::ArrayExpression(arr) => arr.elements.iter().all(|el| match el {
            ArrayExpressionElement::Elision(_) => true,
            ArrayExpressionElement::SpreadElement(_) => false,
            other => other.as_expression().is_some_and(|e| expr_is_pure(e, ctx)),
        }),
        Expression::ObjectExpression(obj) => obj.properties.iter().all(|prop| match prop {
            ObjectPropertyKind::SpreadProperty(_) => false,
            ObjectPropertyKind::ObjectProperty(p) => !p.computed && expr_is_pure(&p.value, ctx),
        }),
        Expression::UnaryExpression(u) => unary_is_pure(u, ctx),
        Expression::BinaryExpression(b) => binary_is_pure(b, ctx),
        Expression::ParenthesizedExpression(p) => expr_is_pure(&p.expression, ctx),
        Expression::TSAsExpression(e) => expr_is_pure(&e.expression, ctx),
        Expression::TSSatisfiesExpression(e) => expr_is_pure(&e.expression, ctx),
        Expression::TSNonNullExpression(e) => expr_is_pure(&e.expression, ctx),
        Expression::TSTypeAssertion(e) => expr_is_pure(&e.expression, ctx),
        Expression::CallExpression(call) => {
            !call.optional
                && arguments_are_pure(&call.arguments, ctx)
                && ((call.pure && callee_is_pure_reference(&call.callee, ctx))
                    || is_pure_builtin_call(call, ctx)
                    || call_matches_pure_factory(call, ctx))
        }
        Expression::NewExpression(new_expr) => {
            (new_expr.pure
                && callee_is_pure_reference(&new_expr.callee, ctx)
                && arguments_are_pure(&new_expr.arguments, ctx))
                || is_pure_builtin_new(new_expr, ctx)
                || (arguments_are_pure(&new_expr.arguments, ctx)
                    && callee_matches_pure_factory(&new_expr.callee, ctx))
        }
        _ => false,
    }
}

pub(crate) fn unwrap_transparent_expr<'a>(mut expr: &'a Expression<'a>) -> &'a Expression<'a> {
    loop {
        match expr {
            Expression::ParenthesizedExpression(p) => expr = &p.expression,
            Expression::TSAsExpression(e) => expr = &e.expression,
            Expression::TSSatisfiesExpression(e) => expr = &e.expression,
            Expression::TSNonNullExpression(e) => expr = &e.expression,
            Expression::TSTypeAssertion(e) => expr = &e.expression,
            _ => return expr,
        }
    }
}

fn arguments_are_pure(arguments: &[Argument<'_>], ctx: &PurityContext<'_>) -> bool {
    arguments.iter().all(|arg| match arg {
        Argument::SpreadElement(_) => false,
        other => other
            .as_expression()
            .is_some_and(|expr| expr_is_pure(expr, ctx)),
    })
}

fn callee_is_pure_reference(callee: &Expression<'_>, ctx: &PurityContext<'_>) -> bool {
    match unwrap_transparent_expr(callee) {
        Expression::Identifier(_) => true,
        Expression::StaticMemberExpression(member) => {
            callee_is_pure_reference(&member.object, ctx) || expr_is_pure(&member.object, ctx)
        }
        Expression::CallExpression(inner) => expr_is_pure(callee, ctx) && !inner.optional,
        _ => false,
    }
}

fn callee_dotted_path(expr: &Expression<'_>) -> Option<String> {
    match unwrap_transparent_expr(expr) {
        Expression::Identifier(ident) => Some(ident.name.to_string()),
        Expression::StaticMemberExpression(member) => {
            let base = callee_dotted_path(&member.object)?;
            Some(format!("{base}.{}", member.property.name))
        }
        _ => None,
    }
}

fn callee_matches_pure_factory(callee: &Expression<'_>, ctx: &PurityContext<'_>) -> bool {
    let Some(path) = callee_dotted_path(callee) else {
        return false;
    };
    ctx.pure_factories.iter().any(|pattern| {
        if let Some(prefix) = pattern.strip_suffix(".*") {
            path.strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with('.'))
        } else {
            pattern == &path
        }
    })
}

fn call_matches_pure_factory(call: &CallExpression<'_>, ctx: &PurityContext<'_>) -> bool {
    if ctx.pure_factories.is_empty() {
        return false;
    }
    if callee_matches_pure_factory(&call.callee, ctx) {
        return true;
    }
    if let Expression::StaticMemberExpression(member) = unwrap_transparent_expr(&call.callee)
        && let Expression::CallExpression(inner_call) = unwrap_transparent_expr(&member.object)
    {
        return !inner_call.optional
            && arguments_are_pure(&inner_call.arguments, ctx)
            && call_matches_wildcard_pure_factory(inner_call, ctx);
    }
    false
}

fn call_matches_wildcard_pure_factory(call: &CallExpression<'_>, ctx: &PurityContext<'_>) -> bool {
    if let Some(path) = callee_dotted_path(&call.callee)
        && ctx.pure_factories.iter().any(|pattern| {
            pattern.strip_suffix(".*").is_some_and(|prefix| {
                path.strip_prefix(prefix)
                    .is_some_and(|rest| rest.starts_with('.'))
            })
        })
    {
        return true;
    }
    if let Expression::StaticMemberExpression(member) = unwrap_transparent_expr(&call.callee)
        && let Expression::CallExpression(inner_call) = unwrap_transparent_expr(&member.object)
    {
        return !inner_call.optional
            && arguments_are_pure(&inner_call.arguments, ctx)
            && call_matches_wildcard_pure_factory(inner_call, ctx);
    }
    false
}
