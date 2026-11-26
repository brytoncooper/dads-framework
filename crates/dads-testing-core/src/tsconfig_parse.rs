//! Parsing TypeScript configuration files (JSONC: comments and trailing commas), diffing
//! `compilerOptions.paths` against everything outside it, and matching module specifiers against
//! TypeScript path alias patterns.

use serde_json::{Map, Value};
use std::collections::BTreeSet;

/// Outcome of comparing two tsconfig files (base vs head).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TsconfigDiff {
    /// Only `compilerOptions.paths` changed (or nothing semantically changed at all).
    PathsOnly {
        changed_aliases: BTreeSet<String>,
        added_only: bool,
    },
    /// At least one field outside `compilerOptions.paths` changed (or a catch-all `*` alias changed).
    GlobalChange { reason: String },
    /// Either side could not be parsed as valid JSONC or had an invalid tsconfig/paths shape.
    ParseError,
}

/// Strips JSONC comments (`//`, `/* ... */`), optional UTF-8 BOM, and trailing commas before `}`
/// or `]` while preserving string literals verbatim. Returns `None` on unterminated strings or
/// block comments so callers fail closed.
pub fn strip_jsonc(raw: &str) -> Option<String> {
    let without_bom = raw.strip_prefix('\u{FEFF}').unwrap_or(raw);
    let without_comments = strip_jsonc_comments(without_bom)?;
    Some(strip_trailing_commas(&without_comments))
}

fn strip_jsonc_comments(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                let end = scan_string_end(bytes, i)?;
                out.push_str(&input[i..end]);
                i = end;
            }
            b'/' if i + 1 < bytes.len() && bytes[i + 1] == b'/' => {
                i += 2;
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if i + 1 < bytes.len() && bytes[i + 1] == b'*' => {
                i += 2;
                let mut closed = false;
                while i + 1 < bytes.len() {
                    if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                        i += 2;
                        closed = true;
                        break;
                    }
                    if bytes[i] == b'\n' {
                        out.push('\n');
                    }
                    i += 1;
                }
                if !closed {
                    return None;
                }
            }
            _ => {
                let ch = input[i..].chars().next()?;
                out.push(ch);
                i += ch.len_utf8();
            }
        }
    }
    Some(out)
}

fn strip_trailing_commas(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"'
            && let Some(end) = scan_string_end(bytes, i)
        {
            out.push_str(&input[i..end]);
            i = end;
            continue;
        }
        if bytes[i] == b',' && next_non_whitespace_is_closer(bytes, i + 1) {
            i += 1;
            continue;
        }
        if let Some(ch) = input[i..].chars().next() {
            out.push(ch);
            i += ch.len_utf8();
        } else {
            break;
        }
    }
    out
}

fn scan_string_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => {
                i += 2;
            }
            b'"' => return Some(i + 1),
            _ => {
                i += 1;
            }
        }
    }
    None
}

fn next_non_whitespace_is_closer(bytes: &[u8], mut i: usize) -> bool {
    while i < bytes.len() {
        match bytes[i] {
            b' ' | b'\t' | b'\r' | b'\n' => i += 1,
            b'}' | b']' => return true,
            _ => return false,
        }
    }
    false
}

/// Parses a JSONC tsconfig string into a `serde_json::Value`.
pub(crate) fn parse_tsconfig_jsonc(raw: &str) -> Option<Value> {
    let clean = strip_jsonc(raw)?;
    serde_json::from_str(&clean).ok()
}

/// Compares `base_raw` and `head_raw` tsconfigs. Returns `TsconfigDiff::PathsOnly` strictly when
/// both parse cleanly and every field outside `compilerOptions.paths` is identical.
pub(crate) fn diff_tsconfig_paths(base_raw: &str, head_raw: &str) -> TsconfigDiff {
    let (Some(Value::Object(base_obj)), Some(Value::Object(head_obj))) = (
        parse_tsconfig_jsonc(base_raw),
        parse_tsconfig_jsonc(head_raw),
    ) else {
        return TsconfigDiff::ParseError;
    };

    if let Some(reason) = diff_top_level_outside_compiler_options(&base_obj, &head_obj) {
        return TsconfigDiff::GlobalChange { reason };
    }

    let (base_co, head_co) = match (
        extract_optional_object(&base_obj, "compilerOptions"),
        extract_optional_object(&head_obj, "compilerOptions"),
    ) {
        (Some(b), Some(h)) => (b, h),
        _ => return TsconfigDiff::ParseError,
    };

    if let Some(reason) = diff_compiler_options_outside_paths(base_co, head_co) {
        return TsconfigDiff::GlobalChange { reason };
    }

    let (base_paths, head_paths) = match (
        base_co.map_or(Some(None), |co| extract_optional_object(co, "paths")),
        head_co.map_or(Some(None), |co| extract_optional_object(co, "paths")),
    ) {
        (Some(b), Some(h)) => (b, h),
        _ => return TsconfigDiff::ParseError,
    };

    if !all_paths_values_valid(base_paths) || !all_paths_values_valid(head_paths) {
        return TsconfigDiff::ParseError;
    }

    compute_changed_aliases(base_paths, head_paths)
}

/// Returns `Some(Some(&Map))` if present and an object, `Some(None)` if absent, or `None` if
/// present with a non-object value (malformed).
fn extract_optional_object<'a>(
    obj: &'a Map<String, Value>,
    key: &str,
) -> Option<Option<&'a Map<String, Value>>> {
    match obj.get(key) {
        None => Some(None),
        Some(Value::Object(inner)) => Some(Some(inner)),
        Some(_) => None,
    }
}

fn diff_top_level_outside_compiler_options(
    base_obj: &Map<String, Value>,
    head_obj: &Map<String, Value>,
) -> Option<String> {
    let all_keys: BTreeSet<&String> = base_obj.keys().chain(head_obj.keys()).collect();
    for key in all_keys {
        if key == "compilerOptions" {
            continue;
        }
        if base_obj.get(key) != head_obj.get(key) {
            return Some(format!("top-level field `{key}` changed"));
        }
    }
    None
}

fn diff_compiler_options_outside_paths(
    base_co: Option<&Map<String, Value>>,
    head_co: Option<&Map<String, Value>>,
) -> Option<String> {
    let empty = Map::new();
    let base_map = base_co.unwrap_or(&empty);
    let head_map = head_co.unwrap_or(&empty);
    let all_keys: BTreeSet<&String> = base_map.keys().chain(head_map.keys()).collect();
    for key in all_keys {
        if key == "paths" {
            continue;
        }
        if base_map.get(key) != head_map.get(key) {
            return Some(format!("compilerOptions.{key} changed"));
        }
    }
    None
}

fn all_paths_values_valid(paths: Option<&Map<String, Value>>) -> bool {
    let Some(map) = paths else {
        return true;
    };
    map.values().all(|v| {
        v.as_array()
            .is_some_and(|arr| arr.iter().all(Value::is_string))
    })
}

fn compute_changed_aliases(
    base_paths: Option<&Map<String, Value>>,
    head_paths: Option<&Map<String, Value>>,
) -> TsconfigDiff {
    let empty = Map::new();
    let base_map = base_paths.unwrap_or(&empty);
    let head_map = head_paths.unwrap_or(&empty);

    let mut changed_aliases = BTreeSet::new();
    let mut has_modified_or_removed = false;

    for (key, head_val) in head_map {
        match base_map.get(key) {
            None => {
                changed_aliases.insert(key.clone());
            }
            Some(base_val) if base_val != head_val => {
                changed_aliases.insert(key.clone());
                has_modified_or_removed = true;
            }
            _ => {}
        }
    }
    for key in base_map.keys() {
        if !head_map.contains_key(key) {
            changed_aliases.insert(key.clone());
            has_modified_or_removed = true;
        }
    }

    for alias in &changed_aliases {
        let star_count = alias.bytes().filter(|&b| b == b'*').count();
        if star_count > 1 {
            return TsconfigDiff::ParseError;
        }
        if alias == "*" {
            return TsconfigDiff::GlobalChange {
                reason: "catch-all wildcard path alias `*` changed".to_owned(),
            };
        }
    }

    TsconfigDiff::PathsOnly {
        added_only: !has_modified_or_removed && !changed_aliases.is_empty(),
        changed_aliases,
    }
}

/// Returns true when a raw import specifier matches a TypeScript `compilerOptions.paths` pattern.
///
/// Relative (`./`, `../`, `.`, `..`), `node:`, and `virtual:` specifiers never consult `paths`.
/// Query suffixes (`?raw`, `?url`) are stripped before matching.
pub fn specifier_matches_alias(specifier: &str, pattern: &str) -> bool {
    let spec = specifier.split_once('?').map_or(specifier, |(s, _)| s);
    if spec.is_empty()
        || spec == "."
        || spec == ".."
        || spec.starts_with("./")
        || spec.starts_with("../")
        || spec.starts_with("node:")
        || spec.starts_with("virtual:")
        || spec.starts_with('\0')
    {
        return false;
    }
    match pattern.split_once('*') {
        None => spec == pattern,
        Some((prefix, suffix)) => {
            spec.len() >= prefix.len() + suffix.len()
                && spec.starts_with(prefix)
                && spec.ends_with(suffix)
        }
    }
}
