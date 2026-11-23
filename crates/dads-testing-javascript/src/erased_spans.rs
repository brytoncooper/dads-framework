//! Identifies source spans that emit zero runtime JavaScript: comments plus TypeScript-only
//! top-level declarations (`type`, `interface`, `export type`, `import type`, and bodyless
//! function overload signatures).

use crate::facts::JsSpan;
use crate::spans::copied_span;
use oxc_allocator::Allocator;
use oxc_ast::ast::{Declaration, Statement};
use oxc_parser::Parser;
use oxc_span::SourceType;
use std::path::Path;

/// Returns `(comment_spans, erased_non_runtime_spans)` for a syntactically valid JS/TS file,
/// where `erased_non_runtime_spans` includes comments plus TypeScript-only top-level declarations
/// that emit zero runtime JavaScript.
pub(crate) fn comment_and_type_only_spans_from_source(
    source: &str,
    path: &Path,
) -> Option<(Vec<JsSpan>, Vec<JsSpan>)> {
    let source_type = SourceType::from_path(path).ok()?;
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if parsed.panicked || !parsed.diagnostics.is_empty() {
        return None;
    }
    let comments = parsed
        .program
        .comments
        .iter()
        .map(|comment| copied_span(comment.span))
        .collect::<Vec<_>>();
    let mut erased = comments.clone();
    if source_type.is_typescript() {
        for stmt in &parsed.program.body {
            let span = match stmt {
                Statement::TSTypeAliasDeclaration(d) => Some(d.span),
                Statement::TSInterfaceDeclaration(d) => Some(d.span),
                Statement::FunctionDeclaration(f) if f.body.is_none() => Some(f.span),
                Statement::ExportDeclaration(e)
                    if matches!(
                        &e.declaration,
                        Declaration::TSTypeAliasDeclaration(_)
                            | Declaration::TSInterfaceDeclaration(_)
                    ) || matches!(
                        &e.declaration,
                        Declaration::FunctionDeclaration(f) if f.body.is_none()
                    ) =>
                {
                    Some(e.span)
                }
                Statement::ExportNamedDeclaration(e) if e.export_kind.is_type() => Some(e.span),
                Statement::ExportFromDeclaration(e) if e.export_kind.is_type() => Some(e.span),
                Statement::ImportDeclaration(i) if i.import_kind.is_type() => Some(i.span),
                _ => None,
            };
            if let Some(span) = span {
                erased.push(copied_span(span));
            }
        }
    }
    Some((comments, erased))
}
