//! Per-statement top-level classification for module-evaluation soundness analysis.
//!
//! Classifies every top-level declaration and statement in an Oxc `Program` into:
//! - declaration ownership spans (`decl_spans`) for reverse def-use attribution, and
//! - `effectful_nodes` for statements/initializers that can run side effects at module load time.

use crate::intra_file_purity::{
    DeclNode, PurityContext, class_is_pure, expr_is_pure, find_root_symbol,
};
use oxc_ast::ast::{BindingPattern, Declaration, ExportDefaultDeclarationKind, Program, Statement};
use oxc_span::{GetSpan, Span};
use std::collections::BTreeSet;

pub(crate) struct TopLevelDecls {
    pub(crate) decl_spans: Vec<(Span, DeclNode)>,
    pub(crate) effectful_nodes: BTreeSet<DeclNode>,
}

/// Classifies every top-level declaration and runtime statement in `program` into declaration
/// ownership spans plus the exact subset of nodes that can execute side effects at module load.
pub(crate) fn classify_top_level_statements(
    program: &Program<'_>,
    ctx: &PurityContext<'_>,
) -> TopLevelDecls {
    let mut out = TopLevelDecls {
        decl_spans: Vec::new(),
        effectful_nodes: BTreeSet::new(),
    };
    for (idx, stmt) in program.body.iter().enumerate() {
        match stmt {
            Statement::ImportDeclaration(imp) => {
                if !imp.import_kind.is_type()
                    && imp.specifiers.as_ref().is_none_or(|specs| specs.is_empty())
                {
                    let node = DeclNode::EffectfulStmt(idx);
                    out.decl_spans.push((imp.span, node));
                    out.effectful_nodes.insert(node);
                }
            }
            Statement::ExportAllDeclaration(_)
            | Statement::ExportNamedDeclaration(_)
            | Statement::ExportFromDeclaration(_)
            | Statement::EmptyStatement(_) => {}
            Statement::ExportDeclaration(export) => {
                classify_declaration(&export.declaration, Some(export.span), idx, ctx, &mut out);
            }
            Statement::ExportDefaultDeclaration(export) => {
                classify_default_export(&export.declaration, export.span, idx, ctx, &mut out);
            }
            other => {
                if let Some(decl) = other.as_declaration() {
                    classify_declaration(decl, None, idx, ctx, &mut out);
                } else {
                    let node = DeclNode::EffectfulStmt(idx);
                    out.decl_spans.push((other.span(), node));
                    out.effectful_nodes.insert(node);
                }
            }
        }
    }
    out
}

fn classify_default_export(
    kind: &ExportDefaultDeclarationKind<'_>,
    statement_span: Span,
    stmt_idx: usize,
    ctx: &PurityContext<'_>,
    out: &mut TopLevelDecls,
) {
    match kind {
        ExportDefaultDeclarationKind::FunctionDeclaration(func) => {
            let node = func
                .id
                .as_ref()
                .and_then(|id| find_root_symbol(ctx.semantic, id.name.as_str(), id.span))
                .map_or(DeclNode::DefaultExport, DeclNode::Symbol);
            out.decl_spans.push((statement_span, node));
        }
        ExportDefaultDeclarationKind::ClassDeclaration(class) => {
            let node = class
                .id
                .as_ref()
                .and_then(|id| find_root_symbol(ctx.semantic, id.name.as_str(), id.span))
                .map_or(DeclNode::DefaultExport, DeclNode::Symbol);
            out.decl_spans.push((statement_span, node));
            if !class_is_pure(class, ctx) {
                out.effectful_nodes.insert(node);
            }
        }
        ExportDefaultDeclarationKind::TSInterfaceDeclaration(_) => {
            out.decl_spans
                .push((statement_span, DeclNode::TypeOnlyStmt(stmt_idx)));
        }
        other => {
            let pure = other
                .as_expression()
                .is_some_and(|expr| expr_is_pure(expr, ctx));
            out.decl_spans
                .push((statement_span, DeclNode::DefaultExport));
            if !pure {
                out.effectful_nodes.insert(DeclNode::DefaultExport);
            }
        }
    }
}

fn classify_declaration(
    decl: &Declaration<'_>,
    export_span: Option<Span>,
    stmt_idx: usize,
    ctx: &PurityContext<'_>,
    out: &mut TopLevelDecls,
) {
    match decl {
        Declaration::FunctionDeclaration(func) => {
            if let Some(id) = func.id.as_ref()
                && let Some(sym) = find_root_symbol(ctx.semantic, id.name.as_str(), id.span)
            {
                out.decl_spans.push((func.span, DeclNode::Symbol(sym)));
            } else if func.body.is_none() {
                out.decl_spans.push((
                    export_span.unwrap_or(func.span),
                    DeclNode::TypeOnlyStmt(stmt_idx),
                ));
            } else {
                let node = DeclNode::EffectfulStmt(stmt_idx);
                out.decl_spans
                    .push((export_span.unwrap_or(func.span), node));
                out.effectful_nodes.insert(node);
            }
        }
        Declaration::ClassDeclaration(class) => {
            let node = class
                .id
                .as_ref()
                .and_then(|id| find_root_symbol(ctx.semantic, id.name.as_str(), id.span))
                .map_or(DeclNode::EffectfulStmt(stmt_idx), DeclNode::Symbol);
            out.decl_spans.push((class.span, node));
            if !class_is_pure(class, ctx) {
                out.effectful_nodes.insert(node);
            }
        }
        Declaration::VariableDeclaration(var_decl) => {
            classify_variable_declaration(var_decl, stmt_idx, ctx, out);
        }
        Declaration::TSTypeAliasDeclaration(alias) => {
            let node = find_root_symbol(ctx.semantic, alias.id.name.as_str(), alias.id.span)
                .map_or(DeclNode::TypeOnlyStmt(stmt_idx), DeclNode::Symbol);
            out.decl_spans.push((alias.span, node));
        }
        Declaration::TSInterfaceDeclaration(iface) => {
            let node = find_root_symbol(ctx.semantic, iface.id.name.as_str(), iface.id.span)
                .map_or(DeclNode::TypeOnlyStmt(stmt_idx), DeclNode::Symbol);
            out.decl_spans.push((iface.span, node));
        }
        Declaration::TSEnumDeclaration(en) => {
            classify_enum_declaration(en, stmt_idx, ctx, out);
        }
        other => {
            let node = DeclNode::EffectfulStmt(stmt_idx);
            out.decl_spans
                .push((export_span.unwrap_or_else(|| other.span()), node));
            out.effectful_nodes.insert(node);
        }
    }
}

fn classify_variable_declaration(
    var_decl: &oxc_ast::ast::VariableDeclaration<'_>,
    stmt_idx: usize,
    ctx: &PurityContext<'_>,
    out: &mut TopLevelDecls,
) {
    for declarator in &var_decl.declarations {
        if let BindingPattern::BindingIdentifier(ident) = &declarator.id
            && let Some(sym) = find_root_symbol(ctx.semantic, ident.name.as_str(), ident.span)
        {
            let node = DeclNode::Symbol(sym);
            let pure = declarator
                .init
                .as_ref()
                .is_none_or(|init| expr_is_pure(init, ctx));
            out.decl_spans.push((declarator.span, node));
            if !pure {
                out.effectful_nodes.insert(node);
            }
        } else {
            let node = DeclNode::EffectfulStmt(stmt_idx);
            out.decl_spans.push((declarator.span, node));
            out.effectful_nodes.insert(node);
        }
    }
}

fn classify_enum_declaration(
    en: &oxc_ast::ast::TSEnumDeclaration<'_>,
    stmt_idx: usize,
    ctx: &PurityContext<'_>,
    out: &mut TopLevelDecls,
) {
    if en.declare {
        out.decl_spans
            .push((en.span, DeclNode::TypeOnlyStmt(stmt_idx)));
        return;
    }
    let node = find_root_symbol(ctx.semantic, en.id.name.as_str(), en.id.span)
        .map_or(DeclNode::EffectfulStmt(stmt_idx), DeclNode::Symbol);
    out.decl_spans.push((en.span, node));
    let has_impure_member = en.body.members.iter().any(|member| {
        member
            .initializer
            .as_ref()
            .is_some_and(|init| !expr_is_pure(init, ctx))
    });
    if has_impure_member || matches!(node, DeclNode::EffectfulStmt(_)) {
        out.effectful_nodes.insert(node);
    }
}
