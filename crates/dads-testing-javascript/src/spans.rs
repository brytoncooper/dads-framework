//! Byte spans and the human positions they map to. Oxc spans are copied into owned `JsSpan`
//! values here so nothing downstream needs an Oxc type to describe where a fact came from.

use crate::facts::{JsPosition, JsSpan};
use oxc_span::Span;

pub(crate) fn copied_span(span: Span) -> JsSpan {
    JsSpan {
        start: span.start,
        end: span.end,
    }
}

pub(crate) fn byte_span(start: usize, end: usize) -> JsSpan {
    JsSpan {
        start: u32::try_from(start).unwrap_or(u32::MAX),
        end: u32::try_from(end).unwrap_or(u32::MAX),
    }
}

pub(crate) fn span_is_contained_by(inner: Span, outer: Span) -> bool {
    outer.start <= inner.start && inner.end <= outer.end
}

pub(crate) fn static_string_at_span(source: &str, span: Span) -> Option<String> {
    let text = source.get(span.start as usize..span.end as usize)?.trim();
    let quote = text.chars().next()?;
    if !matches!(quote, '\'' | '\"') || !text.ends_with(quote) || text.len() < quote.len_utf8() * 2
    {
        return None;
    }
    Some(text[quote.len_utf8()..text.len() - quote.len_utf8()].to_owned())
}

/// Converts a byte offset into a one-based line and character column. Offsets past the end of the
/// source, or inside a character, clamp to the nearest preceding boundary rather than panicking.
pub(crate) fn line_and_column(source: &str, offset: u32) -> JsPosition {
    let mut clamped = usize::try_from(offset)
        .unwrap_or(usize::MAX)
        .min(source.len());
    while clamped > 0 && !source.is_char_boundary(clamped) {
        clamped -= 1;
    }
    let preceding = &source[..clamped];
    let line = preceding.matches('\n').count().saturating_add(1);
    let column = preceding
        .rsplit('\n')
        .next()
        .map_or(0, |current_line| current_line.chars().count())
        .saturating_add(1);
    JsPosition {
        line: u32::try_from(line).unwrap_or(u32::MAX),
        column: u32::try_from(column).unwrap_or(u32::MAX),
    }
}
