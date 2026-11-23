//! SQL statement lexer, identifier normalizer, and static TS/JS query string extractor.

/// Normalizes a SQL table identifier to lowercase `schema.table` (defaulting to `public`).
pub(crate) fn normalize_sql_object(raw: &str) -> Option<String> {
    let cleaned = raw.trim().trim_end_matches(';').trim();
    if cleaned.is_empty() {
        return None;
    }
    let parts: Vec<String> = cleaned
        .split('.')
        .map(|part| {
            part.trim()
                .trim_matches('"')
                .trim_matches('`')
                .to_ascii_lowercase()
        })
        .collect();
    if parts.is_empty() || parts.len() > 2 || parts.iter().any(|p| !is_valid_sql_ident(p)) {
        return None;
    }
    if parts.len() == 1 {
        Some(format!("public.{}", parts[0]))
    } else {
        Some(format!("{}.{}", parts[0], parts[1]))
    }
}

fn is_valid_sql_ident(ident: &str) -> bool {
    !ident.is_empty()
        && ident
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'$')
}

/// Extracts static SQL strings passed to `.query(...)`, `.execute(...)`, or `.raw(...)`.
/// Returns `None` if any call uses template interpolation (`${...}`) or non-literal SQL.
pub(crate) fn extract_static_ts_sql_queries(source: &str) -> Option<Vec<String>> {
    let mut sql_chunks = Vec::new();
    let bytes = source.as_bytes();
    let mut idx = 0;
    while idx < bytes.len() {
        if bytes[idx] == b'/' && idx + 1 < bytes.len() && bytes[idx + 1] == b'/' {
            while idx < bytes.len() && bytes[idx] != b'\n' {
                idx += 1;
            }
            continue;
        }
        if bytes[idx] == b'/' && idx + 1 < bytes.len() && bytes[idx + 1] == b'*' {
            idx += 2;
            while idx + 1 < bytes.len() && !(bytes[idx] == b'*' && bytes[idx + 1] == b'/') {
                idx += 1;
            }
            idx = (idx + 2).min(bytes.len());
            continue;
        }
        if let Some(next_idx) = match_query_call_start(source, idx) {
            idx = next_idx;
            while idx < bytes.len() && bytes[idx].is_ascii_whitespace() {
                idx += 1;
            }
            let (literal, after) = read_static_js_string(source, idx)?;
            sql_chunks.push(literal);
            idx = after;
            continue;
        }
        idx += 1;
    }
    Some(sql_chunks)
}

fn match_query_call_start(source: &str, idx: usize) -> Option<usize> {
    for pattern in [".query(", ".execute(", ".raw(", ".sql("] {
        if source[idx..].starts_with(pattern) {
            return Some(idx + pattern.len());
        }
    }
    None
}

fn read_static_js_string(source: &str, start: usize) -> Option<(String, usize)> {
    let bytes = source.as_bytes();
    let quote = *bytes.get(start)?;
    if !matches!(quote, b'\'' | b'"' | b'`') {
        return None;
    }
    let mut out = String::new();
    let mut i = start + 1;
    while i < bytes.len() {
        let ch = bytes[i];
        if ch == b'\\' && i + 1 < bytes.len() {
            let escaped = bytes[i + 1];
            out.push(match escaped {
                b'n' => '\n',
                b'r' => '\r',
                b't' => '\t',
                other => other as char,
            });
            i += 2;
            continue;
        }
        if quote == b'`' && ch == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            return None;
        }
        if ch == quote {
            return Some((out, i + 1));
        }
        let next_char = source[i..].chars().next()?;
        out.push(next_char);
        i += next_char.len_utf8();
    }
    None
}

pub(crate) fn split_sql_statements(sql: &str) -> Option<Vec<String>> {
    let bytes = sql.as_bytes();
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            current.push(' ');
            continue;
        }
        if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i = skip_block_comment(bytes, i + 2)?;
            current.push(' ');
            continue;
        }
        if bytes[i] == b'\'' {
            i = copy_single_quoted(sql, i, &mut current)?;
            continue;
        }
        if bytes[i] == b'$'
            && let Some(tag) = dollar_quote_tag(&sql[i..])
        {
            current.push_str(tag);
            i += tag.len();
            let rest = &sql[i..];
            let end_rel = rest.find(tag)?;
            current.push_str(&rest[..end_rel + tag.len()]);
            i += end_rel + tag.len();
            continue;
        }
        if bytes[i] == b';' {
            statements.push(std::mem::take(&mut current));
            i += 1;
            continue;
        }
        let ch = sql[i..].chars().next()?;
        current.push(ch);
        i += ch.len_utf8();
    }
    if !current.trim().is_empty() {
        statements.push(current);
    }
    Some(statements)
}

fn skip_block_comment(bytes: &[u8], mut i: usize) -> Option<usize> {
    while i + 1 < bytes.len() {
        if bytes[i] == b'*' && bytes[i + 1] == b'/' {
            return Some(i + 2);
        }
        i += 1;
    }
    None
}

fn copy_single_quoted(sql: &str, start: usize, current: &mut String) -> Option<usize> {
    let bytes = sql.as_bytes();
    current.push('\'');
    let mut i = start + 1;
    while i < bytes.len() {
        if bytes[i] == b'\'' {
            current.push('\'');
            i += 1;
            if i < bytes.len() && bytes[i] == b'\'' {
                current.push('\'');
                i += 1;
                continue;
            }
            return Some(i);
        }
        let ch = sql[i..].chars().next()?;
        current.push(ch);
        i += ch.len_utf8();
    }
    None
}

fn dollar_quote_tag(rest: &str) -> Option<&str> {
    let bytes = rest.as_bytes();
    if bytes.first() != Some(&b'$') {
        return None;
    }
    let mut i = 1;
    while i < bytes.len() {
        if bytes[i] == b'$' {
            return Some(&rest[..=i]);
        }
        if !(bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
            return None;
        }
        i += 1;
    }
    None
}

pub(crate) fn tokenize_sql_head(statement: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    for ch in statement.chars() {
        if in_single {
            if ch == '\'' {
                in_single = false;
            }
            continue;
        }
        if in_double {
            current.push(ch);
            if ch == '"' {
                in_double = false;
            }
            continue;
        }
        match ch {
            '\'' => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
                in_single = true;
            }
            '"' => {
                current.push(ch);
                in_double = true;
            }
            c if c.is_ascii_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            '(' | ')' | ',' => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
                tokens.push(ch.to_string());
            }
            other => current.push(other),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}
