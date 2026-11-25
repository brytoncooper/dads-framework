use crate::tsconfig_parse::{TsconfigDiff, diff_tsconfig_paths, parse_tsconfig_jsonc, specifier_matches_alias};
use std::collections::BTreeSet;

#[test]
fn parses_jsonc_with_comments_bom_and_trailing_commas() {
    let raw = "\u{FEFF}{\n  // top comment\n  \"compilerOptions\": {\n    /* block comment */\n    \"baseUrl\": \".\",\n    \"paths\": {\n      \"@acme/ui\": [\"packages/ui/src/index.ts\",], // trailing\n      \"https://not-a-comment/*ok*/\": [\"packages/x/index.ts\"],\n    },\n  },\n}\n";
    let parsed = parse_tsconfig_jsonc(raw);
    assert!(parsed.is_some());
}

#[test]
fn rejects_unterminated_block_comment_and_malformed_json() {
    assert!(parse_tsconfig_jsonc("{ /* unclosed }").is_none());
    assert!(parse_tsconfig_jsonc("{ \"compilerOptions\": { \"strict\": true ").is_none());
    assert!(parse_tsconfig_jsonc("{ \"a\": \"unterminated }").is_none());
}

#[test]
fn diffs_paths_only_add_modify_remove() {
    let base = r#"{
        "compilerOptions": {
            "strict": true,
            "paths": {
                "@acme/a": ["packages/a/src/index.ts"],
                "@acme/b/*": ["packages/b/src/*"]
            }
        }
    }"#;
    let head = r#"{
        // comment added
        "compilerOptions": {
            "strict": true,
            "paths": {
                "@acme/a": ["packages/a-v2/src/index.ts"],
                "@acme/c": ["packages/c/src/index.ts"],
            },
        }
    }"#;
    assert_eq!(
        diff_tsconfig_paths(base, head),
        TsconfigDiff::PathsOnly {
            changed_aliases: BTreeSet::from([
                "@acme/a".to_owned(),
                "@acme/b/*".to_owned(),
                "@acme/c".to_owned(),
            ]),
            added_only: false,
        }
    );
}

#[test]
fn detects_global_change_outside_paths() {
    let base = r#"{ "compilerOptions": { "strict": false, "paths": {} } }"#;
    let head = r#"{ "compilerOptions": { "strict": true, "paths": {} } }"#;
    assert!(matches!(
        diff_tsconfig_paths(base, head),
        TsconfigDiff::GlobalChange { .. }
    ));
}

#[test]
fn detects_top_level_extends_change() {
    let base = r#"{ "extends": "./tsconfig.base.json", "compilerOptions": { "paths": {} } }"#;
    let head = r#"{ "extends": "./tsconfig.other.json", "compilerOptions": { "paths": {} } }"#;
    assert!(matches!(
        diff_tsconfig_paths(base, head),
        TsconfigDiff::GlobalChange { .. }
    ));
}

#[test]
fn catch_all_wildcard_alias_widens() {
    let base = r#"{ "compilerOptions": { "paths": {} } }"#;
    let head = r#"{ "compilerOptions": { "paths": { "*": ["types/*"] } } }"#;
    assert!(matches!(
        diff_tsconfig_paths(base, head),
        TsconfigDiff::GlobalChange { .. }
    ));
}

#[test]
fn specifier_matching_handles_exact_wildcard_and_non_bare() {
    assert!(specifier_matches_alias("@acme/ui", "@acme/ui"));
    assert!(specifier_matches_alias("@acme/ui?raw", "@acme/ui"));
    assert!(!specifier_matches_alias("@acme/ui/button", "@acme/ui"));
    assert!(specifier_matches_alias("@acme/ui/button", "@acme/ui/*"));
    assert!(specifier_matches_alias("@acme/ui/a/b", "@acme/ui/*"));
    assert!(!specifier_matches_alias("@acme/ui", "@acme/ui/*"));
    assert!(specifier_matches_alias("@acme/foo/index", "@acme/*/index"));
    assert!(!specifier_matches_alias("@acme/index", "@acme/*/index"));
    assert!(!specifier_matches_alias("./local", "*"));
    assert!(!specifier_matches_alias("../parent", "*"));
    assert!(!specifier_matches_alias("node:fs", "node:*"));
}
