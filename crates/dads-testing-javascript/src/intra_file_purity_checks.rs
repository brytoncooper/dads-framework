//! Strict side-effect & load-throw checks for pure expressions:
//! - Fresh-literal-only `Object.freeze(...)` (rejecting in-place freezing of shared bindings)
//! - Primitive-literal-only implicit coercions (`TemplateLiteral`, `BinaryExpression`, `UnaryExpression`, `Symbol`)
//! - ECMAScript syntax validation for `new RegExp(pattern, flags)`
//! - Root-scope Temporal Dead Zone (TDZ) & unknown-global checks for top-level identifiers

use crate::intra_file_purity::{PurityContext, expr_is_pure, unwrap_transparent_expr};
use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast::ast::{
    Argument, ArrayExpressionElement, BinaryExpression, BinaryOperator, CallExpression, Expression,
    IdentifierReference, NewExpression, ObjectPropertyKind, TemplateLiteral, UnaryExpression,
    UnaryOperator, VariableDeclarationKind,
};
use oxc_parser::Parser;
use oxc_semantic::Semantic;
use oxc_span::{GetSpan, SourceType};

const SAFE_UNSHADOWED_GLOBALS: &[&str] = &[
    "undefined",
    "NaN",
    "Infinity",
    "Object",
    "Array",
    "Map",
    "Set",
    "Symbol",
    "Math",
    "JSON",
    "Date",
    "RegExp",
    "Error",
    "TypeError",
    "RangeError",
    "Promise",
    "Number",
    "String",
    "Boolean",
    "BigInt",
    "globalThis",
    "Uint8Array",
    "URL",
];

pub(crate) fn is_unshadowed_global(semantic: &Semantic<'_>, name: &str) -> bool {
    let scoping = semantic.scoping();
    scoping
        .get_binding(scoping.root_scope_id(), name.into())
        .is_none()
}

/// Checks that reading `ident` at module load cannot throw a TDZ `ReferenceError` or an
/// undeclared-global `ReferenceError`.
pub(crate) fn identifier_is_tdz_safe(
    ident: &IdentifierReference<'_>,
    semantic: &Semantic<'_>,
) -> bool {
    let Some(ref_id) = ident.reference_id.get() else {
        return false;
    };
    let scoping = semantic.scoping();
    let Some(symbol_id) = scoping.get_reference(ref_id).symbol_id() else {
        return SAFE_UNSHADOWED_GLOBALS.contains(&ident.name.as_str());
    };
    if scoping.symbol_scope_id(symbol_id) != scoping.root_scope_id() {
        return true;
    }
    let nodes = semantic.nodes();
    let mut saw_decl = false;
    for decl_node_id in scoping.symbol_declarations(symbol_id) {
        saw_decl = true;
        let decl_node = nodes.get_node(decl_node_id);
        let is_hoisted = match decl_node.kind() {
            AstKind::Function(_)
            | AstKind::ImportSpecifier(_)
            | AstKind::ImportDefaultSpecifier(_)
            | AstKind::ImportNamespaceSpecifier(_)
            | AstKind::TSInterfaceDeclaration(_)
            | AstKind::TSTypeAliasDeclaration(_) => true,
            AstKind::VariableDeclarator(_) => matches!(
                nodes.parent_node(decl_node_id).kind(),
                AstKind::VariableDeclaration(v) if v.kind == VariableDeclarationKind::Var
            ),
            AstKind::Class(_) => false,
            _ => {
                // BindingIdentifier inside VariableDeclarator / Function / Class / Import
                let parent = nodes.parent_node(decl_node_id);
                match parent.kind() {
                    AstKind::Function(_)
                    | AstKind::ImportSpecifier(_)
                    | AstKind::ImportDefaultSpecifier(_)
                    | AstKind::ImportNamespaceSpecifier(_) => true,
                    AstKind::VariableDeclarator(_) => matches!(
                        nodes.parent_node(parent.id()).kind(),
                        AstKind::VariableDeclaration(v) if v.kind == VariableDeclarationKind::Var
                    ),
                    _ => false,
                }
            }
        };
        if !is_hoisted {
            let decl_span = decl_node.span();
            if decl_span.end > ident.span.start {
                return false;
            }
        }
    }
    saw_decl
}

/// True only for primitive literals that cannot invoke user-defined `[Symbol.toPrimitive]`,
/// `valueOf`, or `toString` and cannot throw BigInt mixing errors.
pub(crate) fn expr_is_primitive_literal(expr: &Expression<'_>, semantic: &Semantic<'_>) -> bool {
    match unwrap_transparent_expr(expr) {
        Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::StringLiteral(_) => true,
        Expression::Identifier(ident) => {
            ident.name == "undefined" && is_unshadowed_global(semantic, "undefined")
        }
        Expression::UnaryExpression(u) => {
            matches!(
                u.operator,
                UnaryOperator::UnaryPlus
                    | UnaryOperator::UnaryNegation
                    | UnaryOperator::BitwiseNot
                    | UnaryOperator::LogicalNot
            ) && expr_is_primitive_literal(&u.argument, semantic)
        }
        _ => false,
    }
}

pub(crate) fn template_is_pure(tpl: &TemplateLiteral<'_>, ctx: &PurityContext<'_>) -> bool {
    tpl.expressions
        .iter()
        .all(|expr| expr_is_primitive_literal(expr, ctx.semantic))
}

pub(crate) fn unary_is_pure(unary: &UnaryExpression<'_>, ctx: &PurityContext<'_>) -> bool {
    match unary.operator {
        UnaryOperator::Delete => false,
        UnaryOperator::LogicalNot | UnaryOperator::Void => expr_is_pure(&unary.argument, ctx),
        UnaryOperator::Typeof => match unwrap_transparent_expr(&unary.argument) {
            Expression::Identifier(ident) => {
                // `typeof undeclared` never throws, but `typeof tdzConst` DOES throw ReferenceError.
                let Some(ref_id) = ident.reference_id.get() else {
                    return false;
                };
                if ctx
                    .semantic
                    .scoping()
                    .get_reference(ref_id)
                    .symbol_id()
                    .is_none()
                {
                    true
                } else {
                    identifier_is_tdz_safe(ident, ctx.semantic)
                }
            }
            other => expr_is_pure(other, ctx),
        },
        UnaryOperator::UnaryPlus | UnaryOperator::UnaryNegation | UnaryOperator::BitwiseNot => {
            expr_is_primitive_literal(&unary.argument, ctx.semantic)
        }
    }
}

pub(crate) fn binary_is_pure(binary: &BinaryExpression<'_>, ctx: &PurityContext<'_>) -> bool {
    match binary.operator {
        BinaryOperator::StrictEquality | BinaryOperator::StrictInequality => {
            expr_is_pure(&binary.left, ctx) && expr_is_pure(&binary.right, ctx)
        }
        BinaryOperator::In | BinaryOperator::Instanceof => false,
        _ => {
            expr_is_primitive_literal(&binary.left, ctx.semantic)
                && expr_is_primitive_literal(&binary.right, ctx.semantic)
        }
    }
}

pub(crate) fn is_pure_builtin_call(call: &CallExpression<'_>, ctx: &PurityContext<'_>) -> bool {
    match unwrap_transparent_expr(&call.callee) {
        Expression::Identifier(ident)
            if ident.name == "Symbol" && is_unshadowed_global(ctx.semantic, "Symbol") =>
        {
            match call.arguments.as_slice() {
                [] => true,
                [arg] => arg
                    .as_expression()
                    .is_some_and(|expr| expr_is_primitive_literal(expr, ctx.semantic)),
                _ => false,
            }
        }
        Expression::StaticMemberExpression(member)
            if member.property.name == "freeze"
                && matches!(
                    unwrap_transparent_expr(&member.object),
                    Expression::Identifier(ident)
                        if ident.name == "Object" && is_unshadowed_global(ctx.semantic, "Object")
                ) =>
        {
            match call.arguments.as_slice() {
                [] => true,
                [arg] => arg
                    .as_expression()
                    .is_some_and(|expr| expr_is_fresh_pure_literal(expr, ctx)),
                _ => false,
            }
        }
        _ => false,
    }
}

/// True only for freshly allocated literals or primitives that `Object.freeze` cannot mutate
/// observably on any pre-existing binding (`Object.freeze(sharedObj)` is rejected).
fn expr_is_fresh_pure_literal(expr: &Expression<'_>, ctx: &PurityContext<'_>) -> bool {
    match unwrap_transparent_expr(expr) {
        Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::BigIntLiteral(_)
        | Expression::RegExpLiteral(_)
        | Expression::StringLiteral(_)
        | Expression::ArrowFunctionExpression(_)
        | Expression::FunctionExpression(_) => true,
        Expression::ObjectExpression(obj) => obj.properties.iter().all(|prop| match prop {
            ObjectPropertyKind::SpreadProperty(_) => false,
            ObjectPropertyKind::ObjectProperty(p) => !p.computed && expr_is_pure(&p.value, ctx),
        }),
        Expression::ArrayExpression(arr) => arr.elements.iter().all(|el| match el {
            ArrayExpressionElement::Elision(_) => true,
            ArrayExpressionElement::SpreadElement(_) => false,
            other => other.as_expression().is_some_and(|e| expr_is_pure(e, ctx)),
        }),
        Expression::CallExpression(call) => !call.optional && is_pure_builtin_call(call, ctx),
        Expression::NewExpression(new_expr) => is_pure_builtin_new(new_expr, ctx),
        _ => false,
    }
}

pub(crate) fn is_pure_builtin_new(new_expr: &NewExpression<'_>, ctx: &PurityContext<'_>) -> bool {
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
    let (pattern, flags) = match arguments {
        [] => return true,
        [arg0] => (arg0, None),
        [arg0, arg1] => (arg0, Some(arg1)),
        _ => return false,
    };
    let flags_str = match flags {
        None => "",
        Some(arg1) => {
            let Some(Expression::StringLiteral(lit)) =
                arg1.as_expression().map(unwrap_transparent_expr)
            else {
                return false;
            };
            lit.value.as_str()
        }
    };
    if !valid_regexp_flags(flags_str) {
        return false;
    }
    match pattern.as_expression().map(unwrap_transparent_expr) {
        Some(Expression::RegExpLiteral(_)) => true,
        Some(Expression::StringLiteral(lit)) => {
            valid_regexp_pattern_and_flags(lit.value.as_str(), flags_str)
        }
        _ => false,
    }
}

fn valid_regexp_flags(flags: &str) -> bool {
    let mut seen: u8 = 0;
    let mut has_u = false;
    let mut has_v = false;
    for byte in flags.bytes() {
        let bit = match byte {
            b'd' => 1 << 0,
            b'g' => 1 << 1,
            b'i' => 1 << 2,
            b'm' => 1 << 3,
            b's' => 1 << 4,
            b'u' => {
                has_u = true;
                1 << 5
            }
            b'v' => {
                has_v = true;
                1 << 6
            }
            b'y' => 1 << 7,
            _ => return false,
        };
        if (seen & bit) != 0 {
            return false;
        }
        seen |= bit;
    }
    !(has_u && has_v)
}

fn valid_regexp_pattern_and_flags(pattern: &str, flags: &str) -> bool {
    if pattern
        .chars()
        .any(|c| matches!(c, '\r' | '\n' | '\u{2028}' | '\u{2029}'))
    {
        return false;
    }
    let body = if pattern.is_empty() {
        "(?:)".to_owned()
    } else {
        escape_unescaped_slashes(pattern)
    };
    let source = format!("/{body}/{flags};");
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, &source, SourceType::mjs()).parse();
    !parsed.panicked && parsed.diagnostics.is_empty()
}

fn escape_unescaped_slashes(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len());
    let mut escaped = false;
    let mut in_char_class = false;
    for ch in pattern.chars() {
        if escaped {
            out.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            out.push(ch);
            escaped = true;
        } else if ch == '[' && !in_char_class {
            in_char_class = true;
            out.push(ch);
        } else if ch == ']' && in_char_class {
            in_char_class = false;
            out.push(ch);
        } else if ch == '/' && !in_char_class {
            out.push('\\');
            out.push('/');
        } else {
            out.push(ch);
        }
    }
    out
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
