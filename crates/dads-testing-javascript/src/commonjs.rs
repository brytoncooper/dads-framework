//! CommonJS has no module record, so its requires and module-value assignments are read by a byte
//! scanner. The scanner skips comments and quoted text and never assigns meaning to expressions.

use crate::facts::{JsImportFact, JsImportKind, JsSpan, JsSymbolFact, JsUncertainty};
use crate::import_declarations::{ImportFactContext, ImportFactInput, import_fact};
use crate::spans::byte_span;
use oxc_resolver::Resolver;
use std::collections::BTreeSet;
use std::path::Path;

pub(crate) fn scan_commonjs_requires(
    workspace_root: &Path,
    absolute_path: &Path,
    path: &str,
    resolver: &Resolver,
    source: &str,
    uncertainties: &mut Vec<JsUncertainty>,
) -> Vec<JsImportFact> {
    let mut imports = Vec::new();
    let mut offset = 0;
    while offset < source.len() {
        let remaining = &source[offset..];
        if remaining.starts_with("//") {
            offset = skip_line_comment(source, offset + 2);
            continue;
        }
        if remaining.starts_with("/*") {
            offset = skip_block_comment(source, offset + 2);
            continue;
        }
        let byte = source.as_bytes()[offset];
        if matches!(byte, b'\'' | b'\"' | b'`') {
            offset = skip_quoted_text(source, offset + 1, byte);
            continue;
        }
        if remaining.starts_with("require(") && is_commonjs_require_call(source, offset) {
            let argument_start = offset + "require(".len();
            let after_open = &source[argument_start..];
            let whitespace = after_open.len() - after_open.trim_start().len();
            let value_start = argument_start + whitespace;
            let Some(quote) = source[value_start..]
                .chars()
                .next()
                .filter(|character| matches!(character, '\'' | '\"'))
            else {
                uncertainties.push(JsUncertainty {
                    path: path.to_owned(),
                    code: "nonliteral-commonjs-require".to_owned(),
                    message: "A CommonJS require does not have a static module specifier."
                        .to_owned(),
                    span: Some(byte_span(value_start, value_start.saturating_add(1))),
                    position: None,
                });
                offset = value_start.saturating_add(1);
                continue;
            };
            let content_start = value_start + quote.len_utf8();
            let Some(relative_end) = source[content_start..].find(quote) else {
                uncertainties.push(JsUncertainty {
                    path: path.to_owned(),
                    code: "nonliteral-commonjs-require".to_owned(),
                    message: "A CommonJS require could not be read as a static string.".to_owned(),
                    span: Some(byte_span(value_start, content_start)),
                    position: None,
                });
                offset = content_start;
                continue;
            };
            let content_end = content_start + relative_end;
            let specifier = &source[content_start..content_end];
            imports.push(import_fact(
                ImportFactContext {
                    workspace_root,
                    absolute_path,
                    path,
                    resolver,
                    uncertainties: &mut *uncertainties,
                },
                ImportFactInput {
                    specifier,
                    span: byte_span(content_start, content_end),
                    kind: JsImportKind::CommonJsRequire,
                    type_only: false,
                    requested_symbols: BTreeSet::new(),
                    namespace_import: false,
                    reexport_all: false,
                    reexport_namespace: None,
                    member_reads: None,
                },
            ));
            offset = content_end + quote.len_utf8();
            continue;
        }
        offset += remaining.chars().next().map_or(1, char::len_utf8);
    }
    imports
}

fn is_commonjs_require_call(source: &str, start: usize) -> bool {
    let bytes = source.as_bytes();
    let prev = start.checked_sub(1).and_then(|i| bytes.get(i)).copied();
    if prev.is_some_and(|b| is_javascript_identifier_byte(b) || b == b'.') {
        return false;
    }
    let before = source[..start].trim_end();
    let prev_word = before
        .rsplit(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '$')
        .next()
        .unwrap_or("");
    if matches!(
        prev_word,
        "function" | "async" | "get" | "set" | "private" | "public" | "protected" | "static"
    ) {
        return false;
    }
    // A method declaration like `require(a: T): R {` has `{` or `:` right after the closing `)`.
    let after_close = matching_close_paren(source, start + "require(".len())
        .map(|i| source[i..].trim_start().as_bytes().first().copied());
    !matches!(after_close, Some(Some(b'{' | b':')))
}

fn matching_close_paren(source: &str, mut offset: usize) -> Option<usize> {
    let mut depth = 1_u32;
    while offset < source.len() {
        let remaining = &source[offset..];
        if remaining.starts_with("//") {
            offset = skip_line_comment(source, offset + 2);
            continue;
        }
        if remaining.starts_with("/*") {
            offset = skip_block_comment(source, offset + 2);
            continue;
        }
        let byte = source.as_bytes()[offset];
        if matches!(byte, b'\'' | b'\"' | b'`') {
            offset = skip_quoted_text(source, offset + 1, byte);
            continue;
        }
        match byte {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(offset + 1);
                }
            }
            _ => {}
        }
        offset += remaining.chars().next().map_or(1, char::len_utf8);
    }
    None
}

const COMMONJS_MODULE_VALUE_EXPORT: &str = "__dads_commonjs_module_value__";

/// Finds complete `module.exports = ...` assignments without assigning meanings to properties of
/// their right-hand side. The synthetic name is intentionally private to this frontend: core
/// treats a resolved runtime import with no requested symbols as a module-value wildcard.
pub(crate) fn scan_commonjs_module_value_exports(source: &str) -> Vec<JsSymbolFact> {
    let mut declarations = Vec::new();
    let mut offset = 0;
    while offset < source.len() {
        let remaining = &source[offset..];
        if remaining.starts_with("//") {
            offset = skip_line_comment(source, offset + 2);
            continue;
        }
        if remaining.starts_with("/*") {
            offset = skip_block_comment(source, offset + 2);
            continue;
        }
        let byte = source.as_bytes()[offset];
        if matches!(byte, b'\'' | b'\"' | b'`') {
            offset = skip_quoted_text(source, offset + 1, byte);
            continue;
        }
        if source[offset..].starts_with("module.exports")
            && is_module_exports_assignment_start(source, offset)
        {
            let assignment_start = offset;
            let mut equals_offset = offset + "module.exports".len();
            equals_offset = skip_ascii_whitespace(source, equals_offset);
            if source.as_bytes().get(equals_offset) == Some(&b'=')
                && !source
                    .as_bytes()
                    .get(equals_offset + 1)
                    .is_some_and(|byte| matches!(*byte, b'=' | b'>'))
            {
                let assignment_end = commonjs_assignment_end(source, equals_offset + 1);
                declarations.push(JsSymbolFact {
                    name: COMMONJS_MODULE_VALUE_EXPORT.to_owned(),
                    span: JsSpan {
                        start: assignment_start as u32,
                        end: assignment_end as u32,
                    },
                });
                offset = assignment_end;
                continue;
            }
        }
        offset += source[offset..].chars().next().map_or(1, char::len_utf8);
    }
    declarations
}

fn is_module_exports_assignment_start(source: &str, start: usize) -> bool {
    let bytes = source.as_bytes();
    let before_is_identifier_or_member = start
        .checked_sub(1)
        .and_then(|offset| bytes.get(offset))
        .is_some_and(|byte| is_javascript_identifier_byte(*byte) || *byte == b'.');
    let after = start + "module.exports".len();
    let after_is_identifier = bytes
        .get(after)
        .is_some_and(|byte| is_javascript_identifier_byte(*byte));
    !before_is_identifier_or_member && !after_is_identifier
}

fn is_javascript_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$')
}

fn skip_ascii_whitespace(source: &str, mut offset: usize) -> usize {
    while source
        .as_bytes()
        .get(offset)
        .is_some_and(|byte| byte.is_ascii_whitespace())
    {
        offset += 1;
    }
    offset
}

fn commonjs_assignment_end(source: &str, mut offset: usize) -> usize {
    let mut nesting = 0_u32;
    while offset < source.len() {
        let remaining = &source[offset..];
        if remaining.starts_with("//") {
            offset = skip_line_comment(source, offset + 2);
            continue;
        }
        if remaining.starts_with("/*") {
            offset = skip_block_comment(source, offset + 2);
            continue;
        }
        let byte = source.as_bytes()[offset];
        if matches!(byte, b'\'' | b'\"' | b'`') {
            offset = skip_quoted_text(source, offset + 1, byte);
            continue;
        }
        match byte {
            b'(' | b'[' | b'{' => nesting += 1,
            b')' | b']' | b'}' => nesting = nesting.saturating_sub(1),
            b';' if nesting == 0 => return offset + 1,
            // Regular-expression literals require parser context. Extending the declaration to
            // EOF is conservative and avoids ending inside a regex containing a semicolon.
            b'/' => return source.len(),
            _ => {}
        }
        offset += source[offset..].chars().next().map_or(1, char::len_utf8);
    }
    source.len()
}

fn skip_line_comment(source: &str, offset: usize) -> usize {
    source[offset..]
        .find('\n')
        .map_or(source.len(), |relative| offset + relative + 1)
}

fn skip_block_comment(source: &str, offset: usize) -> usize {
    source[offset..]
        .find("*/")
        .map_or(source.len(), |relative| offset + relative + 2)
}

fn skip_quoted_text(source: &str, mut offset: usize, quote: u8) -> usize {
    while let Some(byte) = source.as_bytes().get(offset) {
        if *byte == b'\\' {
            offset = offset.saturating_add(2);
            continue;
        }
        offset += 1;
        if *byte == quote {
            break;
        }
    }
    offset.min(source.len())
}
