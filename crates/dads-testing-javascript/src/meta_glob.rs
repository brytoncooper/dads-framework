//! `import.meta.glob(...)` static prefix extraction and glob matching.

use crate::facts::JsSpan;
use crate::file_discovery::{WorkspaceFileIndex, is_ignored_workspace_rel_path};
use crate::path_eval::{is_import_meta, unwrap_transparent_expr};
use crate::spans::copied_span;
use crate::workspace::{normalize_lexical, workspace_relative_path};
use oxc_ast::ast::{Argument, CallExpression, Expression};
use oxc_span::Span;
use std::collections::BTreeMap;
use std::path::Path;

pub(crate) struct GlobExpandCtx<'a> {
    pub(crate) workspace_root: &'a Path,
    pub(crate) file_dir: &'a Path,
    pub(crate) current_path: &'a str,
    pub(crate) workspace_index: &'a WorkspaceFileIndex,
    pub(crate) max_expansion_files: usize,
}

pub(crate) fn is_import_meta_glob(call: &CallExpression<'_>) -> bool {
    matches!(
        unwrap_transparent_expr(&call.callee),
        Expression::StaticMemberExpression(member)
            if is_import_meta(&member.object) && member.property.name.as_str() == "glob"
    )
}

pub(crate) fn expand_meta_glob_call(
    call: &CallExpression<'_>,
    ctx: &GlobExpandCtx<'_>,
    targets: &mut BTreeMap<String, JsSpan>,
) {
    let Some(first) = call.arguments.first().and_then(Argument::as_expression) else {
        return;
    };
    let mut patterns = Vec::new();
    match unwrap_transparent_expr(first) {
        Expression::ArrayExpression(arr) => {
            for elem in &arr.elements {
                if let Some(expr) = elem.as_expression()
                    && let Some(text) = static_literal_str(expr)
                {
                    patterns.push(text);
                }
            }
        }
        other => {
            if let Some(text) = static_literal_str(other) {
                patterns.push(text);
            }
        }
    }
    for pattern in patterns {
        expand_glob_pattern(pattern, ctx, call.span, targets);
    }
}

fn static_literal_str<'a>(expr: &'a Expression<'a>) -> Option<&'a str> {
    match unwrap_transparent_expr(expr) {
        Expression::StringLiteral(lit) => Some(lit.value.as_str()),
        Expression::TemplateLiteral(tpl) if tpl.expressions.is_empty() => tpl
            .quasis
            .first()
            .map(|q| q.value.cooked.as_deref().unwrap_or(q.value.raw.as_str())),
        _ => None,
    }
}

fn expand_glob_pattern(
    pattern: &str,
    ctx: &GlobExpandCtx<'_>,
    span: Span,
    targets: &mut BTreeMap<String, JsSpan>,
) {
    if pattern.is_empty() || pattern.starts_with('!') {
        return;
    }
    let Some(canonical_root) = ctx.workspace_index.canonical_root() else {
        return;
    };
    let (anchor, rel_pattern) = match pattern.strip_prefix('/') {
        Some(rest) => (ctx.workspace_root, rest),
        None => (ctx.file_dir, pattern),
    };
    if !rel_pattern.contains(['*', '?', '[', '{']) {
        let Ok(canonical_target) = normalize_lexical(&anchor.join(rel_pattern)).canonicalize()
        else {
            return;
        };
        if canonical_target.starts_with(canonical_root)
            && canonical_target.is_file()
            && let Some(rel) = workspace_relative_path(canonical_root, &canonical_target)
            && !is_ignored_workspace_rel_path(&rel)
            && rel != ctx.current_path
        {
            targets.entry(rel).or_insert_with(|| copied_span(span));
        }
        return;
    }
    let segments: Vec<&str> = rel_pattern.split('/').collect();
    let glob_idx = segments
        .iter()
        .position(|seg| seg.contains(['*', '?', '[', '{']))
        .unwrap_or(segments.len());
    let static_prefix = segments[..glob_idx].join("/");
    let prefix_dir = if static_prefix.is_empty() {
        anchor.to_path_buf()
    } else {
        anchor.join(&static_prefix)
    };
    let Ok(canonical_dir) = normalize_lexical(&prefix_dir).canonicalize() else {
        return;
    };
    if !canonical_dir.starts_with(canonical_root) || !canonical_dir.is_dir() {
        return;
    }
    let Some(dir_rel) = workspace_relative_path(canonical_root, &canonical_dir) else {
        return;
    };
    if dir_rel.is_empty() || dir_rel == "." || is_ignored_workspace_rel_path(&dir_rel) {
        return;
    }
    let files = ctx.workspace_index.files_under_dir(&dir_rel);
    if files.is_empty() || files.len() > ctx.max_expansion_files {
        return;
    }
    let tail_segments = &segments[glob_idx..];
    let has_complex_syntax = tail_segments
        .iter()
        .any(|seg| seg.contains(['{', '[']) || (seg.contains("**") && *seg != "**"));
    let prefix_with_slash = format!("{dir_rel}/");
    for file_rel in files {
        if file_rel == ctx.current_path {
            continue;
        }
        let Some(relative_tail) = file_rel.strip_prefix(&prefix_with_slash) else {
            continue;
        };
        let file_segs: Vec<&str> = relative_tail.split('/').collect();
        if has_complex_syntax || glob_segments_match(tail_segments, &file_segs) {
            targets
                .entry(file_rel.clone())
                .or_insert_with(|| copied_span(span));
        }
    }
}

fn glob_segments_match(pat: &[&str], path: &[&str]) -> bool {
    match (pat.first(), path.first()) {
        (None, None) => true,
        (Some(&"**"), _) => {
            glob_segments_match(&pat[1..], path)
                || (!path.is_empty() && glob_segments_match(pat, &path[1..]))
        }
        (Some(p), Some(s)) => {
            wildcard_segment_match(p, s) && glob_segments_match(&pat[1..], &path[1..])
        }
        _ => false,
    }
}

fn wildcard_segment_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0, 0);
    let (mut star_p, mut star_t) = (None, 0);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star_p = Some(pi);
            star_t = ti;
            pi += 1;
        } else if let Some(sp) = star_p {
            pi = sp + 1;
            star_t += 1;
            ti = star_t;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}
