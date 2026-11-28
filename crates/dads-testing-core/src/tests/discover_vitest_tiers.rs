use crate::discover_vitest_tiers::inspect_vitest_tiers;

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
    assert!(
        info.excluded_tier_suffixes
            .contains(&".integration.test.ts".to_owned())
    );
    assert!(
        info.excluded_tier_suffixes
            .contains(&".e2e.test.ts".to_owned())
    );
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
