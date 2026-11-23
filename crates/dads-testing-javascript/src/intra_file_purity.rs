//! Purity checks for top-level statements and expressions used by intra-file def-use analysis.

use oxc_ast::ast::{
    ArrayExpressionElement, BindingPattern, Class, ClassElement, Declaration,
    ExportDefaultDeclarationKind, Expression, ObjectPropertyKind,
};
use oxc_semantic::Semantic;
use oxc_span::Span;
use oxc_syntax::symbol::SymbolId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum DeclNode {
    Symbol(SymbolId),
    DefaultExport,
}

pub(crate) fn record_pure_default_export(
    kind: &ExportDefaultDeclarationKind<'_>,
    statement_span: Span,
    semantic: &Semantic<'_>,
    out: &mut Vec<(Span, DeclNode)>,
) -> Option<()> {
    match kind {
        ExportDefaultDeclarationKind::FunctionDeclaration(func) => {
            let node = func
                .id
                .as_ref()
                .and_then(|id| find_root_symbol(semantic, id.name.as_str(), id.span))
                .map_or(DeclNode::DefaultExport, DeclNode::Symbol);
            out.push((statement_span, node));
            Some(())
        }
        ExportDefaultDeclarationKind::ClassDeclaration(class) => {
            if !class_is_pure(class) {
                return None;
            }
            let node = class
                .id
                .as_ref()
                .and_then(|id| find_root_symbol(semantic, id.name.as_str(), id.span))
                .map_or(DeclNode::DefaultExport, DeclNode::Symbol);
            out.push((statement_span, node));
            Some(())
        }
        ExportDefaultDeclarationKind::TSInterfaceDeclaration(_) => Some(()),
        other => {
            let expr = other.as_expression()?;
            if !expr_is_pure(expr) {
                return None;
            }
            out.push((statement_span, DeclNode::DefaultExport));
            Some(())
        }
    }
}

pub(crate) fn record_pure_declaration(
    decl: &Declaration<'_>,
    semantic: &Semantic<'_>,
    out: &mut Vec<(Span, DeclNode)>,
) -> Option<()> {
    match decl {
        Declaration::FunctionDeclaration(func) => {
            let id = func.id.as_ref()?;
            let sym = find_root_symbol(semantic, id.name.as_str(), id.span)?;
            out.push((func.span, DeclNode::Symbol(sym)));
            Some(())
        }
        Declaration::ClassDeclaration(class) => {
            if !class_is_pure(class) {
                return None;
            }
            let id = class.id.as_ref()?;
            let sym = find_root_symbol(semantic, id.name.as_str(), id.span)?;
            out.push((class.span, DeclNode::Symbol(sym)));
            Some(())
        }
        Declaration::VariableDeclaration(var_decl) => {
            for declarator in &var_decl.declarations {
                let BindingPattern::BindingIdentifier(ident) = &declarator.id else {
                    return None;
                };
                if let Some(init) = &declarator.init
                    && !expr_is_pure(init)
                {
                    return None;
                }
                let sym = find_root_symbol(semantic, ident.name.as_str(), ident.span)?;
                out.push((declarator.span, DeclNode::Symbol(sym)));
            }
            Some(())
        }
        Declaration::TSTypeAliasDeclaration(alias) => {
            if let Some(sym) = find_root_symbol(semantic, alias.id.name.as_str(), alias.id.span) {
                out.push((alias.span, DeclNode::Symbol(sym)));
            }
            Some(())
        }
        Declaration::TSInterfaceDeclaration(iface) => {
            if let Some(sym) = find_root_symbol(semantic, iface.id.name.as_str(), iface.id.span) {
                out.push((iface.span, DeclNode::Symbol(sym)));
            }
            Some(())
        }
        _ => None,
    }
}

pub(crate) fn record_any_declaration(
    decl: &Declaration<'_>,
    semantic: &Semantic<'_>,
    out: &mut Vec<(Span, DeclNode)>,
) {
    match decl {
        Declaration::FunctionDeclaration(func) => {
            if let Some(id) = func.id.as_ref()
                && let Some(sym) = find_root_symbol(semantic, id.name.as_str(), id.span)
            {
                out.push((func.span, DeclNode::Symbol(sym)));
            }
        }
        Declaration::ClassDeclaration(class) => {
            if let Some(id) = class.id.as_ref()
                && let Some(sym) = find_root_symbol(semantic, id.name.as_str(), id.span)
            {
                out.push((class.span, DeclNode::Symbol(sym)));
            }
        }
        Declaration::VariableDeclaration(var_decl) => {
            for declarator in &var_decl.declarations {
                if let BindingPattern::BindingIdentifier(ident) = &declarator.id
                    && let Some(sym) = find_root_symbol(semantic, ident.name.as_str(), ident.span)
                {
                    out.push((declarator.span, DeclNode::Symbol(sym)));
                }
            }
        }
        Declaration::TSTypeAliasDeclaration(alias) => {
            if let Some(sym) = find_root_symbol(semantic, alias.id.name.as_str(), alias.id.span) {
                out.push((alias.span, DeclNode::Symbol(sym)));
            }
        }
        Declaration::TSInterfaceDeclaration(iface) => {
            if let Some(sym) = find_root_symbol(semantic, iface.id.name.as_str(), iface.id.span) {
                out.push((iface.span, DeclNode::Symbol(sym)));
            }
        }
        _ => {}
    }
}

pub(crate) fn find_root_symbol(
    semantic: &Semantic<'_>,
    name: &str,
    span: Span,
) -> Option<SymbolId> {
    use oxc_span::GetSpan;
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

fn class_is_pure(class: &Class<'_>) -> bool {
    if class.decorators.is_empty() && class.heritage.is_none() {
        class.body.body.iter().all(|element| match element {
            ClassElement::StaticBlock(_) => false,
            ClassElement::PropertyDefinition(prop) => {
                prop.decorators.is_empty()
                    && !prop.computed
                    && (!prop.r#static || prop.value.as_ref().is_none_or(|e| expr_is_pure(e)))
            }
            ClassElement::MethodDefinition(method) => {
                method.decorators.is_empty() && !method.computed
            }
            ClassElement::AccessorProperty(prop) => {
                prop.decorators.is_empty()
                    && !prop.computed
                    && (!prop.r#static || prop.value.as_ref().is_none_or(|e| expr_is_pure(e)))
            }
            ClassElement::TSIndexSignature(_) => true,
        })
    } else {
        false
    }
}

fn expr_is_pure(expr: &Expression<'_>) -> bool {
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
        Expression::ClassExpression(class) => class_is_pure(class),
        Expression::TemplateLiteral(tpl) => tpl.expressions.iter().all(expr_is_pure),
        Expression::ArrayExpression(arr) => arr.elements.iter().all(|el| match el {
            ArrayExpressionElement::Elision(_) => true,
            ArrayExpressionElement::SpreadElement(_) => false,
            other => other.as_expression().is_some_and(expr_is_pure),
        }),
        Expression::ObjectExpression(obj) => obj.properties.iter().all(|prop| match prop {
            ObjectPropertyKind::SpreadProperty(_) => false,
            ObjectPropertyKind::ObjectProperty(p) => !p.computed && expr_is_pure(&p.value),
        }),
        Expression::UnaryExpression(u) => expr_is_pure(&u.argument),
        Expression::BinaryExpression(b) => expr_is_pure(&b.left) && expr_is_pure(&b.right),
        Expression::ParenthesizedExpression(p) => expr_is_pure(&p.expression),
        Expression::TSAsExpression(e) => expr_is_pure(&e.expression),
        Expression::TSSatisfiesExpression(e) => expr_is_pure(&e.expression),
        Expression::TSNonNullExpression(e) => expr_is_pure(&e.expression),
        Expression::TSTypeAssertion(e) => expr_is_pure(&e.expression),
        _ => false,
    }
}
