//! Strict fail-closed SQL DDL classifier for migration table-level impact analysis.
//!
//! Directly implements the `MigrationDdl` classification proved in
//! `proofs/dad-test/DadTest/SqlMigration.lean`:
//! - Every SQL statement in a changed migration MUST match the strict table-scoped DDL allowlist.
//! - Any unrecognized or database-wide DDL (`CREATE EXTENSION`, `ALTER ROLE`, `CREATE PUBLICATION`,
//!   `CREATE/ALTER TYPE`, `CREATE FUNCTION`, `DO $$`, `EXECUTE`, `DROP INDEX`, dynamic template
//!   interpolation `${...}`, deleted/unreadable file, etc.) immediately returns
//!   `ParsedMigrationDdl::GlobalDdl` so the planner widens conservatively to all DB tasks.

use crate::sql_lexer::{
    extract_static_ts_sql_queries, normalize_sql_object, split_sql_statements, tokenize_sql_head,
};
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ParsedMigrationDdl {
    Scoped {
        tables: BTreeSet<String>,
        fk_edges: Vec<(String, String)>,
    },
    GlobalDdl {
        reason: String,
    },
}

/// Parses raw SQL source text into either proven table-scoped changes or `GlobalDdl`.
pub(crate) fn parse_sql_migration_source(sql: &str) -> ParsedMigrationDdl {
    let Some(statements) = split_sql_statements(sql) else {
        return global("unterminated SQL comment or string literal".to_owned());
    };
    let mut tables = BTreeSet::new();
    let mut fk_edges = Vec::new();
    for statement in statements {
        let trimmed = statement.trim();
        if trimmed.is_empty() {
            continue;
        }
        match classify_statement(trimmed) {
            ParsedMigrationDdl::Scoped {
                tables: stmt_tables,
                fk_edges: stmt_edges,
            } => {
                tables.extend(stmt_tables);
                fk_edges.extend(stmt_edges);
            }
            global_ddl @ ParsedMigrationDdl::GlobalDdl { .. } => return global_ddl,
        }
    }
    ParsedMigrationDdl::Scoped { tables, fk_edges }
}

/// Extracts static SQL strings from a `.ts`/`.js` migration file (e.g. `queryRunner.query(\`...\`)`).
/// Fails closed to `GlobalDdl` on any `${...}` interpolation, missing static SQL, or global DDL.
pub(crate) fn parse_ts_migration_source(source: &str) -> ParsedMigrationDdl {
    let Some(sql_chunks) = extract_static_ts_sql_queries(source) else {
        return global("dynamic or interpolated SQL query in TS/JS migration".to_owned());
    };
    if sql_chunks.is_empty() {
        return global("no static SQL query calls recognized in TS/JS migration".to_owned());
    }
    let combined = sql_chunks.join(";\n");
    parse_sql_migration_source(&combined)
}

fn classify_statement(statement: &str) -> ParsedMigrationDdl {
    let tokens = tokenize_sql_head(statement);
    let upper: Vec<String> = tokens.iter().map(|t| t.to_ascii_uppercase()).collect();
    let Some(first) = upper.first().map(String::as_str) else {
        return scoped_empty();
    };
    match first {
        "BEGIN" | "COMMIT" => scoped_empty(),
        "START" if upper.get(1).map(String::as_str) == Some("TRANSACTION") => scoped_empty(),
        "SET"
            if matches!(
                upper.get(1).map(String::as_str),
                Some("LOCAL" | "CONSTRAINTS")
            ) =>
        {
            scoped_empty()
        }
        "CREATE" => classify_create(&tokens, &upper),
        "ALTER" => classify_alter(&tokens, &upper),
        "DROP" => classify_drop(&tokens, &upper),
        "COMMENT" => classify_comment(&tokens, &upper),
        "GRANT" | "REVOKE" => classify_grant_or_revoke(&tokens, &upper),
        "TRUNCATE" => classify_truncate(&tokens, &upper),
        _ => global(format!(
            "unrecognized SQL DDL statement starting with {first}"
        )),
    }
}

fn classify_create(tokens: &[String], upper: &[String]) -> ParsedMigrationDdl {
    let mut i = 1;
    while matches!(
        upper.get(i).map(String::as_str),
        Some("OR" | "REPLACE" | "TEMP" | "TEMPORARY" | "UNLOGGED" | "UNIQUE")
    ) {
        i += 1;
    }
    match upper.get(i).map(String::as_str) {
        Some("TABLE") => {
            i += 1;
            if slice_matches(upper, i, &["IF", "NOT", "EXISTS"]) {
                i += 3;
            }
            let Some(table) = tokens.get(i).and_then(|t| normalize_sql_object(t)) else {
                return global("unable to parse CREATE TABLE target".to_owned());
            };
            collect_table_and_references(&table, tokens, upper)
        }
        Some("INDEX") => {
            i += 1;
            if upper.get(i).map(String::as_str) == Some("CONCURRENTLY") {
                i += 1;
            }
            if slice_matches(upper, i, &["IF", "NOT", "EXISTS"]) {
                i += 3;
            }
            let Some(on_pos) = upper[i..].iter().position(|t| t == "ON").map(|p| i + p) else {
                return global("unable to locate ON clause in CREATE INDEX".to_owned());
            };
            let mut tbl_pos = on_pos + 1;
            if upper.get(tbl_pos).map(String::as_str) == Some("ONLY") {
                tbl_pos += 1;
            }
            let Some(table) = tokens.get(tbl_pos).and_then(|t| normalize_sql_object(t)) else {
                return global("unable to parse CREATE INDEX table".to_owned());
            };
            scoped_single(table)
        }
        Some("TRIGGER") => {
            let Some(on_pos) = upper[i..].iter().position(|t| t == "ON").map(|p| i + p) else {
                return global("unable to locate ON clause in CREATE TRIGGER".to_owned());
            };
            let Some(table) = tokens.get(on_pos + 1).and_then(|t| normalize_sql_object(t)) else {
                return global("unable to parse CREATE TRIGGER table".to_owned());
            };
            scoped_single(table)
        }
        other => global(format!(
            "global or unsupported CREATE statement ({})",
            other.unwrap_or("EOF")
        )),
    }
}

fn classify_alter(tokens: &[String], upper: &[String]) -> ParsedMigrationDdl {
    if upper.get(1).map(String::as_str) != Some("TABLE") {
        return global(format!(
            "global or unsupported ALTER statement ({})",
            upper.get(1).map_or("EOF", String::as_str)
        ));
    }
    let mut i = 2;
    if slice_matches(upper, i, &["IF", "EXISTS"]) {
        i += 2;
    }
    if upper.get(i).map(String::as_str) == Some("ONLY") {
        i += 1;
    }
    let Some(table) = tokens.get(i).and_then(|t| normalize_sql_object(t)) else {
        return global("unable to parse ALTER TABLE target".to_owned());
    };
    let mut result = collect_table_and_references(&table, tokens, upper);
    if let ParsedMigrationDdl::Scoped { tables, .. } = &mut result {
        for pos in i + 1..upper.len() {
            if slice_matches(upper, pos, &["RENAME", "TO"])
                && let Some(renamed) = tokens.get(pos + 2).and_then(|t| normalize_sql_object(t))
            {
                tables.insert(renamed);
            }
        }
    }
    result
}

fn classify_drop(tokens: &[String], upper: &[String]) -> ParsedMigrationDdl {
    match upper.get(1).map(String::as_str) {
        Some("TABLE") => {
            let mut i = 2;
            if slice_matches(upper, i, &["IF", "EXISTS"]) {
                i += 2;
            }
            parse_table_list(tokens, upper, i, &["CASCADE", "RESTRICT"])
        }
        Some("TRIGGER") => {
            let Some(on_pos) = upper[2..].iter().position(|t| t == "ON").map(|p| 2 + p) else {
                return global("unable to locate ON clause in DROP TRIGGER".to_owned());
            };
            let Some(table) = tokens.get(on_pos + 1).and_then(|t| normalize_sql_object(t)) else {
                return global("unable to parse DROP TRIGGER table".to_owned());
            };
            scoped_single(table)
        }
        other => global(format!(
            "global or unsupported DROP statement ({})",
            other.unwrap_or("EOF")
        )),
    }
}

fn classify_comment(tokens: &[String], upper: &[String]) -> ParsedMigrationDdl {
    if upper.get(1).map(String::as_str) != Some("ON") {
        return global("unsupported COMMENT syntax".to_owned());
    }
    match upper.get(2).map(String::as_str) {
        Some("TABLE") => {
            let Some(table) = tokens.get(3).and_then(|t| normalize_sql_object(t)) else {
                return global("unable to parse COMMENT ON TABLE target".to_owned());
            };
            scoped_single(table)
        }
        Some("COLUMN") => {
            let Some(raw) = tokens.get(3) else {
                return global("unable to parse COMMENT ON COLUMN target".to_owned());
            };
            let parts: Vec<&str> = raw.split('.').collect();
            let table_raw = match parts.as_slice() {
                [table, _col] => (*table).to_owned(),
                [schema, table, _col] => format!("{schema}.{table}"),
                _ => return global("unable to parse COMMENT ON COLUMN table".to_owned()),
            };
            let Some(table) = normalize_sql_object(&table_raw) else {
                return global("invalid table name in COMMENT ON COLUMN".to_owned());
            };
            scoped_single(table)
        }
        other => global(format!(
            "global or unsupported COMMENT ON {}",
            other.unwrap_or("EOF")
        )),
    }
}

fn classify_grant_or_revoke(tokens: &[String], upper: &[String]) -> ParsedMigrationDdl {
    let Some(on_pos) = upper.iter().position(|t| t == "ON") else {
        return global("GRANT/REVOKE missing ON clause".to_owned());
    };
    let mut i = on_pos + 1;
    if matches!(
        upper.get(i).map(String::as_str),
        Some("ALL" | "SCHEMA" | "DATABASE" | "FUNCTION" | "SEQUENCE" | "TYPE" | "DOMAIN")
    ) {
        return global("schema-wide or non-table GRANT/REVOKE".to_owned());
    }
    if upper.get(i).map(String::as_str) == Some("TABLE") {
        i += 1;
    }
    parse_table_list(tokens, upper, i, &["TO", "FROM"])
}

fn classify_truncate(tokens: &[String], upper: &[String]) -> ParsedMigrationDdl {
    let mut i = 1;
    if upper.get(i).map(String::as_str) == Some("TABLE") {
        i += 1;
    }
    if upper.get(i).map(String::as_str) == Some("ONLY") {
        i += 1;
    }
    parse_table_list(
        tokens,
        upper,
        i,
        &["RESTART", "CONTINUE", "CASCADE", "RESTRICT"],
    )
}

fn parse_table_list(
    tokens: &[String],
    upper: &[String],
    start: usize,
    stop_keywords: &[&str],
) -> ParsedMigrationDdl {
    let mut tables = BTreeSet::new();
    let mut i = start;
    while i < tokens.len() {
        let word = upper[i].as_str();
        if stop_keywords.contains(&word) {
            break;
        }
        if word == "," {
            i += 1;
            continue;
        }
        let Some(table) = normalize_sql_object(&tokens[i]) else {
            return global(format!("unable to parse table name '{}'", tokens[i]));
        };
        tables.insert(table);
        i += 1;
    }
    if tables.is_empty() {
        return global("statement named zero tables".to_owned());
    }
    ParsedMigrationDdl::Scoped {
        tables,
        fk_edges: Vec::new(),
    }
}

fn collect_table_and_references(
    table: &str,
    tokens: &[String],
    upper: &[String],
) -> ParsedMigrationDdl {
    let mut tables = BTreeSet::from([table.to_owned()]);
    let mut fk_edges = Vec::new();
    for (idx, word) in upper.iter().enumerate() {
        if word == "REFERENCES"
            && let Some(parent_tok) = tokens.get(idx + 1)
            && let Some(parent) = normalize_sql_object(parent_tok)
        {
            tables.insert(parent.clone());
            fk_edges.push((table.to_owned(), parent));
        }
    }
    ParsedMigrationDdl::Scoped { tables, fk_edges }
}

fn slice_matches(upper: &[String], start: usize, expected: &[&str]) -> bool {
    upper
        .get(start..start + expected.len())
        .is_some_and(|slice| slice.iter().zip(expected).all(|(a, b)| a == b))
}

fn scoped_empty() -> ParsedMigrationDdl {
    ParsedMigrationDdl::Scoped {
        tables: BTreeSet::new(),
        fk_edges: Vec::new(),
    }
}

fn scoped_single(table: String) -> ParsedMigrationDdl {
    ParsedMigrationDdl::Scoped {
        tables: BTreeSet::from([table]),
        fk_edges: Vec::new(),
    }
}

fn global(reason: String) -> ParsedMigrationDdl {
    ParsedMigrationDdl::GlobalDdl { reason }
}
