//! Static tier-pattern inspection for Vitest config files and the shared explicit-files env key.
//!
//! Strips JS/TS comments before scanning so docblocks never trigger false tier detections.

use std::collections::BTreeSet;

/// Environment variable set to `"1"` whenever `dad-test` invokes a test runner with explicit
/// narrowed file arguments (both single-project narrowed runs and `vitest-files` batches).
pub(crate) const DADS_TEST_EXPLICIT_FILES_ENV: &str = "DADS_TEST_EXPLICIT_FILES";

/// Canonical integration/e2e test file suffixes excluded from unit `:test` narrowing when a
/// project splits unit and container/e2e tiers.
pub(crate) const INTEGRATION_TIER_SUFFIXES: &[&str] = &[
    ".integration.test.ts",
    ".integration.test.tsx",
    ".e2e.test.ts",
    ".e2e.test.tsx",
];

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct VitestTierInfo {
    /// True when the Vitest config switches between unit and integration tiers via `VITEST_TIER`
    /// or `dadsVitestTier()` in auto mode — meaning the project expects a `test:integration` target.
    pub(crate) uses_vitest_tier: bool,
    /// True when the Vitest config uses `dadsVitestTier(...)` or honors `DADS_TEST_EXPLICIT_FILES`.
    pub(crate) uses_dads_vitest_tier: bool,
    /// True when the default (unit) Vitest invocation excludes integration/e2e test suffixes.
    pub(crate) excludes_integration_tiers: bool,
    /// Concrete integration/e2e suffixes excluded by the config in default (unit) mode.
    pub(crate) excluded_tier_suffixes: Vec<String>,
}

/// Inspects a Vitest config file statically for tier-splitting (`VITEST_TIER`, `dadsVitestTier`)
/// and static `.integration.test.*` / `.e2e.test.*` exclusion patterns.
pub(crate) fn inspect_vitest_tiers(source: &str) -> VitestTierInfo {
    let stripped = strip_js_comments(source);
    let has_explicit_env = stripped.contains(DADS_TEST_EXPLICIT_FILES_ENV);
    let has_dads_helper = contains_identifier_call(&stripped, "dadsVitestTier");
    let has_vitest_tier_env = stripped.contains("VITEST_TIER");

    let helper_tier = has_dads_helper
        .then(|| detect_helper_tier(&stripped))
        .flatten();
    let uses_dads_vitest_tier = has_dads_helper || has_explicit_env;
    let uses_vitest_tier =
        has_vitest_tier_env || (has_dads_helper && matches!(helper_tier, None | Some("auto")));

    let mut excluded = BTreeSet::new();
    if uses_vitest_tier || helper_tier == Some("unit") {
        for suffix in INTEGRATION_TIER_SUFFIXES {
            excluded.insert((*suffix).to_owned());
        }
    }
    collect_static_tier_suffixes(&stripped, &mut excluded);

    let excludes_integration_tiers = !excluded.is_empty();
    VitestTierInfo {
        uses_vitest_tier,
        uses_dads_vitest_tier,
        excludes_integration_tiers,
        excluded_tier_suffixes: excluded.into_iter().collect(),
    }
}

fn contains_identifier_call(source: &str, ident: &str) -> bool {
    let mut from = 0;
    while let Some(rel) = source[from..].find(ident) {
        let start = from + rel;
        let prev_ok = start == 0
            || !source[..start]
                .chars()
                .next_back()
                .is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_');
        let after = start + ident.len();
        if prev_ok && source[after..].trim_start().starts_with('(') {
            return true;
        }
        from = after;
    }
    false
}

fn detect_helper_tier(source: &str) -> Option<&'static str> {
    let idx = source.find("dadsVitestTier")?;
    let after = &source[idx..];
    let open = after.find('(')?;
    let close = after[open..].find(')')?;
    let args = &after[open + 1..open + close];
    if args.contains("\"unit\"") || args.contains("'unit'") {
        return Some("unit");
    }
    if args.contains("\"integration\"") || args.contains("'integration'") {
        return Some("integration");
    }
    if args.contains("\"auto\"") || args.contains("'auto'") {
        return Some("auto");
    }
    None
}

fn collect_static_tier_suffixes(source: &str, out: &mut BTreeSet<String>) {
    // Only treat `.integration.test.*` / `.e2e.test.*` literals as unit-tier exclusions when the
    // config actually has an `exclude` field (avoids matching pure integration-only `include` lists).
    if !has_property(source, "exclude") {
        return;
    }
    for suffix in INTEGRATION_TIER_SUFFIXES {
        if source.contains(suffix) {
            out.insert((*suffix).to_owned());
        }
    }
    if source.contains(".integration.test.*") || source.contains(".integration.test.{") {
        out.insert(".integration.test.ts".to_owned());
        out.insert(".integration.test.tsx".to_owned());
    }
    if source.contains(".e2e.test.*") || source.contains(".e2e.test.{") {
        out.insert(".e2e.test.ts".to_owned());
        out.insert(".e2e.test.tsx".to_owned());
    }
}

fn has_property(source: &str, name: &str) -> bool {
    let mut from = 0;
    while let Some(rel) = source[from..].find(name) {
        let start = from + rel;
        let prev_ok = start == 0
            || !source[..start]
                .chars()
                .next_back()
                .is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_');
        let after = start + name.len();
        if prev_ok && source[after..].trim_start().starts_with(':') {
            return true;
        }
        from = after;
    }
    false
}

fn strip_js_comments(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out = String::with_capacity(source.len());
    let mut i = 0;
    let mut quote: Option<u8> = None;
    while i < bytes.len() {
        let b = bytes[i];
        if let Some(q) = quote {
            out.push(b as char);
            if b == b'\\' && i + 1 < bytes.len() {
                out.push(bytes[i + 1] as char);
                i += 2;
                continue;
            }
            if b == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        if b == b'\'' || b == b'"' || b == b'`' {
            quote = Some(b);
            out.push(b as char);
            i += 1;
            continue;
        }
        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                if bytes[i] == b'\n' {
                    out.push('\n');
                }
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }
        out.push(b as char);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_vitest_tier_env_config() {
        let src = r#"
            const TIER_FILES = ["**/*.integration.test.ts", "**/*.e2e.test.ts"];
            const INTEGRATION_TIER = process.env["VITEST_TIER"] === "integration";
            export default { test: { include: INTEGRATION_TIER ? TIER_FILES : ["src/**/*.test.ts"], exclude: [...TIER_FILES] } };
        "#;
        let info = inspect_vitest_tiers(src);
        assert!(info.uses_vitest_tier);
        assert!(!info.uses_dads_vitest_tier);
        assert!(info.excludes_integration_tiers);
        assert!(info.excluded_tier_suffixes.contains(&".integration.test.ts".to_owned()));
        assert!(info.excluded_tier_suffixes.contains(&".e2e.test.ts".to_owned()));
    }

    #[test]
    fn detects_root_static_exclude_without_vitest_tier() {
        let src = r#"
            export default { test: { exclude: ["**/node_modules/**", "**/*.integration.test.ts", "**/*.e2e.test.ts"] } };
        "#;
        let info = inspect_vitest_tiers(src);
        assert!(!info.uses_vitest_tier);
        assert!(!info.uses_dads_vitest_tier);
        assert!(info.excludes_integration_tiers);
        assert_eq!(
            info.excluded_tier_suffixes,
            vec![".e2e.test.ts".to_owned(), ".integration.test.ts".to_owned()]
        );
    }

    #[test]
    fn ignores_comments_and_plain_configs() {
        let src = r#"
            // Comment mentioning VITEST_TIER and **/*.integration.test.ts
            /* Another comment with dadsVitestTier() */
            export default { test: { include: ["src/**/*.test.ts"] } };
        "#;
        let info = inspect_vitest_tiers(src);
        assert!(!info.uses_vitest_tier);
        assert!(!info.uses_dads_vitest_tier);
        assert!(!info.excludes_integration_tiers);
        assert!(info.excluded_tier_suffixes.is_empty());
    }

    #[test]
    fn distinguishes_dads_vitest_tier_unit_vs_auto() {
        let unit_src = r#"export default { test: { ...dadsVitestTier({ tier: "unit" }) } };"#;
        let unit = inspect_vitest_tiers(unit_src);
        assert!(!unit.uses_vitest_tier);
        assert!(unit.uses_dads_vitest_tier);
        assert!(unit.excludes_integration_tiers);

        let auto_src = r#"export default { test: { ...dadsVitestTier() } };"#;
        let auto = inspect_vitest_tiers(auto_src);
        assert!(auto.uses_vitest_tier);
        assert!(auto.uses_dads_vitest_tier);
        assert!(auto.excludes_integration_tiers);
    }
}
