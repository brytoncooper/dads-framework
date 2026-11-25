//! Purity checks for top-level expressions, classes, and pure declarations used by
//! intra-file def-use analysis and load-time side-effect classification.

use oxc_ast::ast::{
    Argument, ArrayExpressionElement, BindingPattern, CallExpression, Class, ClassElement,
    Declaration, ExportDefaultDeclarationKind, Expression, NewExpression, ObjectPropertyKind,
    UnaryOperator,
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
        | Expression::StringLiteral(_)
        | Expression::Identifier(_) => true,
        Expression::ClassExpression(class) => class_is_pure(class, ctx),
        Expression::TemplateLiteral(tpl) => tpl.expressions.iter().all(|e| expr_is_pure(e, ctx)),
        Expression::ArrayExpression(arr) => arr.elements.iter().all(|el| match el {
            ArrayExpressionElement::Elision(_) => true,
            ArrayExpressionElement::SpreadElement(_) => false,
            other => other.as_expression().is_some_and(|e| expr_is_pure(e, ctx)),
        }),
        Expression::ObjectExpression(obj) => obj.properties.iter().all(|prop| match prop {
            ObjectPropertyKind::SpreadProperty(_) => false,
            ObjectPropertyKind::ObjectProperty(p) => !p.computed && expr_is_pure(&p.value, ctx),
        }),
        Expression::UnaryExpression(u) => {
            !matches!(u.operator, UnaryOperator::Delete) && expr_is_pure(&u.argument, ctx)
        }
        Expression::BinaryExpression(b) => {
            expr_is_pure(&b.left, ctx) && expr_is_pure(&b.right, ctx)
        }
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

fn unwrap_transparent_expr<'a>(mut expr: &'a Expression<'a>) -> &'a Expression<'a> {
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

fn is_unshadowed_global(semantic: &Semantic<'_>, name: &str) -> bool {
    let scoping = semantic.scoping();
    scoping
        .get_binding(scoping.root_scope_id(), name.into())
        .is_none()
}

fn is_pure_builtin_call(call: &CallExpression<'_>, ctx: &PurityContext<'_>) -> bool {
    match unwrap_transparent_expr(&call.callee) {
        Expression::Identifier(ident) => {
            ident.name == "Symbol" && is_unshadowed_global(ctx.semantic, "Symbol")
        }
        Expression::StaticMemberExpression(member) => {
            member.property.name == "freeze"
                && matches!(
                    unwrap_transparent_expr(&member.object),
                    Expression::Identifier(ident)
                        if ident.name == "Object" && is_unshadowed_global(ctx.semantic, "Object")
                )
        }
        _ => false,
    }
}

fn is_pure_builtin_new(new_expr: &NewExpression<'_>, ctx: &PurityContext<'_>) -> bool {
    let Expression::Identifier(callee) = unwrap_transparent_expr(&new_expr.callee) else {
        return false;
    };
    let name = callee.name.as_str();
    if !is_unshadowed_global(ctx.semantic, name) {
        return false;
    }
    match name {
        "RegExp" => is_pure_regexp_args(&new_expr.arguments),
        "Set" | "Map" => is_pure_collection_args(&new_expr.arguments, ctx),
        _ => false,
    }
}

fn is_pure_regexp_args(arguments: &[Argument<'_>]) -> bool {
    arguments.len() <= 2
        && arguments.iter().enumerate().all(|(idx, arg)| {
            arg.as_expression().is_some_and(|expr| {
                let inner = unwrap_transparent_expr(expr);
                match idx {
                    0 => matches!(
                        inner,
                        Expression::StringLiteral(_) | Expression::RegExpLiteral(_)
                    ),
                    1 => matches!(inner, Expression::StringLiteral(_)),
                    _ => false,
                }
            })
        })
}

fn is_pure_collection_args(arguments: &[Argument<'_>], ctx: &PurityContext<'_>) -> bool {
    match arguments {
        [] => true,
        [arg] => arg.as_expression().is_some_and(|expr| {
            let inner = unwrap_transparent_expr(expr);
            matches!(inner, Expression::ArrayExpression(_)) && expr_is_pure(inner, ctx)
        }),
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
