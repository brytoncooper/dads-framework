//! Single-pass module binding collector for `fs`, `path`, and `url` imports/requires/destructures
//! plus `const` initializers and `const` arrays used by `fs_reads` and `path_eval`.

use crate::path_eval::{ident_resolved_symbol, unwrap_transparent_expr};
use oxc_ast::AstKind;
use oxc_ast::ast::{
    Argument, ArrayExpressionElement, BindingPattern, CallExpression, Expression,
    ImportDeclaration, ImportDeclarationSpecifier, ObjectPattern, VariableDeclarationKind,
    VariableDeclarator,
};
use oxc_semantic::Semantic;
use oxc_span::Span;
use oxc_syntax::symbol::SymbolId;
use std::collections::{HashMap, HashSet};

pub(crate) const FS_READ_METHODS: &[&str] = &[
    "readFileSync",
    "readFile",
    "readdirSync",
    "readdir",
    "existsSync",
    "statSync",
    "stat",
    "lstatSync",
    "lstat",
    "openSync",
    "open",
    "createReadStream",
    "globSync",
    "glob",
    "accessSync",
    "access",
    "opendirSync",
    "opendir",
    "realpathSync",
    "realpath",
    "readlinkSync",
    "readlink",
];

pub(crate) const CHILD_PROCESS_EXEC_METHODS: &[&str] =
    &["execFileSync", "execFile", "spawnSync", "spawn"];

#[derive(Default)]
pub(crate) struct FsBindings {
    pub(crate) direct_read_syms: HashSet<SymbolId>,
    pub(crate) fs_ns_syms: HashSet<SymbolId>,
    pub(crate) fs_promises_syms: HashSet<SymbolId>,
    pub(crate) direct_exec_syms: HashSet<SymbolId>,
    pub(crate) child_process_ns_syms: HashSet<SymbolId>,
}

#[derive(Default)]
pub(crate) struct PathBindings<'a> {
    pub(crate) join_syms: HashSet<SymbolId>,
    pub(crate) resolve_syms: HashSet<SymbolId>,
    pub(crate) dirname_syms: HashSet<SymbolId>,
    pub(crate) path_ns_syms: HashSet<SymbolId>,
    pub(crate) file_url_to_path_syms: HashSet<SymbolId>,
    pub(crate) url_ns_syms: HashSet<SymbolId>,
    pub(crate) const_inits: HashMap<SymbolId, &'a Expression<'a>>,
}

pub(crate) struct CollectedModule<'a> {
    pub(crate) fs: FsBindings,
    pub(crate) path: PathBindings<'a>,
    pub(crate) const_arrays: Vec<(SymbolId, Span, Vec<&'a Expression<'a>>)>,
}

#[derive(Clone, Copy)]
enum ModuleKind {
    Fs,
    FsPromises,
    ChildProcess,
    Path,
    Url,
}

pub(crate) fn is_fs_module_specifier(specifier: &str) -> bool {
    matches!(
        specifier,
        "fs" | "node:fs"
            | "fs/promises"
            | "node:fs/promises"
            | "child_process"
            | "node:child_process"
    )
}

fn classify_specifier(specifier: &str) -> Option<ModuleKind> {
    match specifier {
        "fs" | "node:fs" => Some(ModuleKind::Fs),
        "fs/promises" | "node:fs/promises" => Some(ModuleKind::FsPromises),
        "child_process" | "node:child_process" => Some(ModuleKind::ChildProcess),
        "path" | "node:path" | "path/posix" | "node:path/posix" => Some(ModuleKind::Path),
        "url" | "node:url" => Some(ModuleKind::Url),
        _ => None,
    }
}

pub(crate) fn collect_module_bindings<'a>(semantic: &'a Semantic<'a>) -> CollectedModule<'a> {
    let mut out = CollectedModule {
        fs: FsBindings::default(),
        path: PathBindings::default(),
        const_arrays: Vec::new(),
    };
    for node in semantic.nodes().iter() {
        match node.kind() {
            AstKind::ImportDeclaration(import) => record_import(import, &mut out),
            AstKind::VariableDeclaration(var_decl) => {
                let is_const = var_decl.kind == VariableDeclarationKind::Const;
                for decl in &var_decl.declarations {
                    record_declarator(decl, is_const, semantic, &mut out);
                }
            }
            _ => {}
        }
    }
    out
}

pub(crate) fn is_fs_ns_expr(
    expr: &Expression<'_>,
    fs: &FsBindings,
    semantic: &Semantic<'_>,
) -> bool {
    matches!(
        unwrap_transparent_expr(expr),
        Expression::Identifier(ident)
            if ident_resolved_symbol(semantic, ident)
                .is_some_and(|sym| fs.fs_ns_syms.contains(&sym))
    )
}

pub(crate) fn is_fs_promises_expr(
    expr: &Expression<'_>,
    fs: &FsBindings,
    semantic: &Semantic<'_>,
) -> bool {
    match unwrap_transparent_expr(expr) {
        Expression::Identifier(ident) => ident_resolved_symbol(semantic, ident)
            .is_some_and(|sym| fs.fs_promises_syms.contains(&sym)),
        Expression::StaticMemberExpression(member) => {
            member.property.name.as_str() == "promises"
                && is_fs_ns_expr(&member.object, fs, semantic)
        }
        _ => false,
    }
}

pub(crate) fn is_child_process_ns_expr(
    expr: &Expression<'_>,
    fs: &FsBindings,
    semantic: &Semantic<'_>,
) -> bool {
    matches!(
        unwrap_transparent_expr(expr),
        Expression::Identifier(ident)
            if ident_resolved_symbol(semantic, ident)
                .is_some_and(|sym| fs.child_process_ns_syms.contains(&sym))
    )
}

fn record_import(import: &ImportDeclaration<'_>, out: &mut CollectedModule<'_>) {
    let Some(kind) = classify_specifier(import.source.value.as_str()) else {
        return;
    };
    let Some(specifiers) = &import.specifiers else {
        return;
    };
    for specifier in specifiers {
        match specifier {
            ImportDeclarationSpecifier::ImportSpecifier(named) => {
                if let Some(sym) = named.local.symbol_id.get() {
                    bind_member(kind, named.imported.name().as_str(), sym, out);
                }
            }
            ImportDeclarationSpecifier::ImportDefaultSpecifier(spec) => {
                if let Some(sym) = spec.local.symbol_id.get() {
                    bind_namespace(kind, sym, out);
                }
            }
            ImportDeclarationSpecifier::ImportNamespaceSpecifier(spec) => {
                if let Some(sym) = spec.local.symbol_id.get() {
                    bind_namespace(kind, sym, out);
                }
            }
        }
    }
}

fn record_declarator<'a>(
    decl: &'a VariableDeclarator<'a>,
    is_const: bool,
    semantic: &'a Semantic<'a>,
    out: &mut CollectedModule<'a>,
) {
    let Some(init) = &decl.init else {
        return;
    };
    if is_const
        && let BindingPattern::BindingIdentifier(ident) = &decl.id
        && let Some(sym) = ident.symbol_id.get()
    {
        out.path.const_inits.insert(sym, init);
        if let Some(elements) = extract_array_elements(init) {
            out.const_arrays.push((sym, decl.span, elements));
        }
    }
    if let Some(kind) = static_require_specifier(init).and_then(classify_specifier) {
        bind_pattern(kind, &decl.id, out);
        return;
    }
    if let Some(kind) = classify_destructure_source(init, semantic, out) {
        bind_pattern(kind, &decl.id, out);
    }
}

fn classify_destructure_source(
    init: &Expression<'_>,
    semantic: &Semantic<'_>,
    out: &CollectedModule<'_>,
) -> Option<ModuleKind> {
    let expr = unwrap_transparent_expr(init);
    if is_fs_promises_expr(expr, &out.fs, semantic) {
        return Some(ModuleKind::FsPromises);
    }
    if is_fs_ns_expr(expr, &out.fs, semantic) {
        return Some(ModuleKind::Fs);
    }
    let Expression::Identifier(ident) = expr else {
        return None;
    };
    let sym = ident_resolved_symbol(semantic, ident)?;
    if out.path.path_ns_syms.contains(&sym) {
        Some(ModuleKind::Path)
    } else if out.path.url_ns_syms.contains(&sym) {
        Some(ModuleKind::Url)
    } else {
        None
    }
}

fn bind_pattern(kind: ModuleKind, pattern: &BindingPattern<'_>, out: &mut CollectedModule<'_>) {
    match pattern {
        BindingPattern::BindingIdentifier(ident) => {
            if let Some(sym) = ident.symbol_id.get() {
                bind_namespace(kind, sym, out);
            }
        }
        BindingPattern::ObjectPattern(obj) => bind_object_pattern(kind, obj, out),
        _ => {}
    }
}

fn bind_object_pattern(
    kind: ModuleKind,
    pattern: &ObjectPattern<'_>,
    out: &mut CollectedModule<'_>,
) {
    for prop in &pattern.properties {
        if let Some(key) = prop.key.static_name()
            && let BindingPattern::BindingIdentifier(local) = &prop.value
            && let Some(sym) = local.symbol_id.get()
        {
            bind_member(kind, key.as_ref(), sym, out);
        }
    }
}

fn bind_namespace(kind: ModuleKind, sym: SymbolId, out: &mut CollectedModule<'_>) {
    match kind {
        ModuleKind::Fs => {
            out.fs.fs_ns_syms.insert(sym);
        }
        ModuleKind::FsPromises => {
            out.fs.fs_promises_syms.insert(sym);
        }
        ModuleKind::ChildProcess => {
            out.fs.child_process_ns_syms.insert(sym);
        }
        ModuleKind::Path => {
            out.path.path_ns_syms.insert(sym);
        }
        ModuleKind::Url => {
            out.path.url_ns_syms.insert(sym);
        }
    }
}

fn bind_member(kind: ModuleKind, member: &str, sym: SymbolId, out: &mut CollectedModule<'_>) {
    match kind {
        ModuleKind::Fs | ModuleKind::FsPromises => {
            if member == "promises" {
                out.fs.fs_promises_syms.insert(sym);
            } else if FS_READ_METHODS.contains(&member) {
                out.fs.direct_read_syms.insert(sym);
            }
        }
        ModuleKind::ChildProcess => {
            if CHILD_PROCESS_EXEC_METHODS.contains(&member) {
                out.fs.direct_exec_syms.insert(sym);
            }
        }
        ModuleKind::Path => match member {
            "join" => {
                out.path.join_syms.insert(sym);
            }
            "resolve" => {
                out.path.resolve_syms.insert(sym);
            }
            "dirname" => {
                out.path.dirname_syms.insert(sym);
            }
            "posix" => {
                out.path.path_ns_syms.insert(sym);
            }
            _ => {}
        },
        ModuleKind::Url if member == "fileURLToPath" => {
            out.path.file_url_to_path_syms.insert(sym);
        }
        ModuleKind::Url => {}
    }
}

fn extract_array_elements<'a>(expr: &'a Expression<'a>) -> Option<Vec<&'a Expression<'a>>> {
    let target = match unwrap_transparent_expr(expr) {
        Expression::CallExpression(call) if is_object_freeze(call) => {
            call.arguments.first().and_then(Argument::as_expression)?
        }
        other => other,
    };
    let Expression::ArrayExpression(array) = unwrap_transparent_expr(target) else {
        return None;
    };
    let elements: Vec<&'a Expression<'a>> = array
        .elements
        .iter()
        .filter_map(ArrayExpressionElement::as_expression)
        .collect();
    (!elements.is_empty()).then_some(elements)
}

fn is_object_freeze(call: &CallExpression<'_>) -> bool {
    matches!(
        unwrap_transparent_expr(&call.callee),
        Expression::StaticMemberExpression(member)
            if member.property.name.as_str() == "freeze"
                && matches!(
                    unwrap_transparent_expr(&member.object),
                    Expression::Identifier(ident) if ident.name.as_str() == "Object"
                )
    )
}

fn static_require_specifier<'a>(expr: &'a Expression<'a>) -> Option<&'a str> {
    let Expression::CallExpression(call) = unwrap_transparent_expr(expr) else {
        return None;
    };
    let Expression::Identifier(callee) = unwrap_transparent_expr(&call.callee) else {
        return None;
    };
    if callee.name.as_str() != "require" || call.arguments.len() != 1 {
        return None;
    }
    let arg = call.arguments.first().and_then(Argument::as_expression)?;
    match unwrap_transparent_expr(arg) {
        Expression::StringLiteral(lit) => Some(lit.value.as_str()),
        _ => None,
    }
}
