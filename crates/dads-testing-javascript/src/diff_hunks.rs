//! Unified-diff hunks reduced to the bytes that actually differ, and the exports that own them.
//! A byte with no owning declaration leaves its hunk unattributed rather than guessing.

use crate::facts::JsSymbolFact;
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy)]
pub(crate) struct LineRange {
    pub(crate) start: u32,
    pub(crate) count: u32,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ChangedHunk {
    pub(crate) old: LineRange,
    pub(crate) new: LineRange,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ByteRange {
    start: usize,
    end: usize,
}

impl ByteRange {
    pub(crate) fn is_empty(self) -> bool {
        self.start >= self.end
    }
}

pub(crate) fn changed_hunks(diff: &str) -> Option<Vec<ChangedHunk>> {
    diff.lines()
        .filter(|line| line.starts_with("@@"))
        .map(parse_changed_hunk)
        .collect()
}

fn parse_changed_hunk(header: &str) -> Option<ChangedHunk> {
    let mut parts = header.split_whitespace();
    if parts.next()? != "@@" {
        return None;
    }
    let old = parse_line_range(parts.next()?, '-')?;
    let new = parse_line_range(parts.next()?, '+')?;
    if parts.next()? != "@@" {
        return None;
    }
    Some(ChangedHunk { old, new })
}

fn parse_line_range(value: &str, prefix: char) -> Option<LineRange> {
    let value = value.strip_prefix(prefix)?;
    let (start, count) = value
        .split_once(',')
        .map_or((value, "1"), |(start, count)| (start, count));
    let start = start.parse().ok()?;
    let count = count.parse().ok()?;
    if count > 0 && start == 0 {
        return None;
    }
    Some(LineRange { start, count })
}

pub(crate) fn changed_content_byte_ranges(
    hunk: ChangedHunk,
    old_source: &str,
    new_source: &str,
) -> Option<(ByteRange, ByteRange)> {
    let old_hunk = byte_range_for_lines(old_source, hunk.old)?;
    let new_hunk = byte_range_for_lines(new_source, hunk.new)?;
    let old_bytes = old_source.as_bytes().get(old_hunk.start..old_hunk.end)?;
    let new_bytes = new_source.as_bytes().get(new_hunk.start..new_hunk.end)?;
    let common_prefix = old_bytes
        .iter()
        .zip(new_bytes)
        .take_while(|(old, new)| old == new)
        .count();
    let remaining_old = old_bytes.len().checked_sub(common_prefix)?;
    let remaining_new = new_bytes.len().checked_sub(common_prefix)?;
    let common_suffix = old_bytes
        .iter()
        .rev()
        .take(remaining_old.min(remaining_new))
        .zip(new_bytes.iter().rev())
        .take_while(|(old, new)| old == new)
        .count();

    Some((
        ByteRange {
            start: old_hunk.start.checked_add(common_prefix)?,
            end: old_hunk.end.checked_sub(common_suffix)?,
        },
        ByteRange {
            start: new_hunk.start.checked_add(common_prefix)?,
            end: new_hunk.end.checked_sub(common_suffix)?,
        },
    ))
}

fn byte_range_for_lines(source: &str, range: LineRange) -> Option<ByteRange> {
    if range.count == 0 {
        return Some(ByteRange { start: 0, end: 0 });
    }
    let start = byte_offset_for_line(source, range.start)?;
    let end_line = range.start.checked_add(range.count.checked_sub(1)?)?;
    let end_line_start = byte_offset_for_line(source, end_line)?;
    let end = source.as_bytes()[end_line_start..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map_or(source.len(), |relative| end_line_start + relative);
    Some(ByteRange { start, end })
}

fn byte_offset_for_line(source: &str, line: u32) -> Option<usize> {
    match line {
        0 => None,
        1 => Some(0),
        _ => source
            .as_bytes()
            .iter()
            .enumerate()
            .filter(|(_, byte)| **byte == b'\n')
            .nth(line.checked_sub(2)? as usize)
            .map(|(offset, _)| offset + 1),
    }
}

pub(crate) fn attributed_exports_for_changed_bytes(
    changed_bytes: ByteRange,
    declarations: &[JsSymbolFact],
    source: &str,
) -> Option<BTreeSet<String>> {
    let bytes = source
        .as_bytes()
        .get(changed_bytes.start..changed_bytes.end)?;
    let mut exports = BTreeSet::new();
    for relative_offset in 0..bytes.len() {
        let offset = changed_bytes.start.checked_add(relative_offset)?;
        let owners = declarations
            .iter()
            .filter(|declaration| {
                (declaration.span.start as usize) <= offset
                    && offset < declaration.span.end as usize
            })
            .collect::<Vec<_>>();
        if owners.is_empty() {
            return None;
        }
        exports.extend(
            owners
                .into_iter()
                .map(|declaration| declaration.name.clone()),
        );
    }
    Some(exports)
}

/// Returns true only when `changed_bytes` is empty OR consists solely of comment bytes and
/// whitespace on comment-only lines (never accepting bare whitespace/newline edits between code
/// tokens, which can change JavaScript ASI semantics such as `return\n 1;` vs `return 1;`).
pub(crate) fn is_comment_only_range(
    changed_bytes: ByteRange,
    comment_spans: &[crate::facts::JsSpan],
    source: &str,
) -> bool {
    if changed_bytes.is_empty() {
        return true;
    }
    let Some(slice) = source
        .as_bytes()
        .get(changed_bytes.start..changed_bytes.end)
    else {
        return false;
    };
    let mut saw_comment_byte = false;
    for (relative_offset, byte) in slice.iter().enumerate() {
        let offset = changed_bytes.start + relative_offset;
        let in_comment = comment_spans
            .iter()
            .any(|span| (span.start as usize) <= offset && offset < span.end as usize);
        if in_comment {
            saw_comment_byte = true;
            continue;
        }
        if matches!(byte, b' ' | b'\t') {
            continue;
        }
        if matches!(byte, b'\n' | b'\r')
            && line_is_whitespace_or_comment(source, offset, comment_spans)
        {
            continue;
        }
        return false;
    }
    saw_comment_byte
}

fn line_is_whitespace_or_comment(
    source: &str,
    offset: usize,
    comment_spans: &[crate::facts::JsSpan],
) -> bool {
    let bytes = source.as_bytes();
    let line_start = bytes[..offset]
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |index| index + 1);
    let line_end = bytes[offset..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map_or(bytes.len(), |relative| offset + relative);
    for (pos, byte) in bytes.iter().enumerate().take(line_end).skip(line_start) {
        if matches!(byte, b' ' | b'\t' | b'\r') {
            continue;
        }
        let in_comment = comment_spans
            .iter()
            .any(|span| (span.start as usize) <= pos && pos < span.end as usize);
        if !in_comment {
            return false;
        }
    }
    true
}
