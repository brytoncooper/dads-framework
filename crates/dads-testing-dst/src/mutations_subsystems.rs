//! Section B (#71-#78) mutations: TypeScript typecheck/ambient `.d.ts`, `import.meta.glob`,
//! SQL migrations, `package-lock.json` v3, `.tsx`/bundler assets, Vitest config/mock,
//! module boundaries, and HTTP remote cache fault injection.

use crate::model::{MutationKind, WorkspaceShape};
use crate::mutations::{AppliedMutation, SpecialTimeline, replace_once};
use std::fs;
use std::path::Path;

pub fn apply_section_b_mutation(
    root: &Path,
    shape: &WorkspaceShape,
    kind: MutationKind,
    step_idx: usize,
) -> Result<AppliedMutation, String> {
    let variant = (shape.seed as usize).wrapping_add(step_idx);
    let mut applied = AppliedMutation::default();
    match kind {
        MutationKind::TypecheckTypeOnlyAndAmbientDts => {
            apply_typecheck_mutation(root, variant, &mut applied)?;
        }
        MutationKind::ImportMetaGlobAddEditDelete => {
            apply_meta_glob_mutation(root, variant, step_idx)?;
        }
        MutationKind::SqlMigrationImpactAndCache => {
            apply_sql_mutation(root, variant, &mut applied)?;
        }
        MutationKind::LockfileAndConditionalExports => {
            apply_lockfile_mutation(root, variant, &mut applied)?;
        }
        MutationKind::TsxJsxAndBundlerQueryAssets => {
            apply_tsx_asset_mutation(root, variant)?;
        }
        MutationKind::VitestViMockHoistedAndConfigSetup => {
            apply_vitest_mutation(root, variant)?;
        }
        MutationKind::ModuleBoundariesViolationAndFix => {
            applied.special_timeline = Some(SpecialTimeline::BoundariesCheck);
        }
        MutationKind::RemoteHttpCacheFaultInjection => {
            applied.special_timeline = Some(SpecialTimeline::RemoteCacheFault);
        }
        _ => return Err(format!("not a section B mutation: {kind:?}")),
    }
    Ok(applied)
}

fn apply_typecheck_mutation(
    root: &Path,
    variant: usize,
    applied: &mut AppliedMutation,
) -> Result<(), String> {
    match variant % 5 {
        0 => {
            replace_once(
                root,
                "types-lib/contracts.ts",
                "export type Currency = \"USD\" | \"EUR\";",
                "export type Currency = \"EUR\";",
            )?;
            applied
                .expected_skipped_tasks
                .push("typecheck-app:test".to_owned());
        }
        1 => {
            replace_once(
                root,
                "types-lib/contracts.ts",
                "  total: number;\n}",
                "  total: number;\n  currency: string;\n}",
            )?;
            applied
                .expected_skipped_tasks
                .push("typecheck-app:test".to_owned());
        }
        2 => {
            replace_once(
                root,
                "types-lib/globals.d.ts",
                "var __DST_AMBIENT_VERSION__: number;",
                "var __DST_AMBIENT_VERSION__: string;",
            )?;
            applied
                .expected_skipped_tasks
                .push("typecheck-app:test".to_owned());
        }
        3 => {
            replace_once(
                root,
                "types-lib/contracts.ts",
                "export function calcNet(n: number): number;",
                "export function calcNet(n: string): number;",
            )?;
            applied
                .expected_skipped_tasks
                .push("typecheck-app:test".to_owned());
        }
        _ => {
            replace_once(
                root,
                "typecheck-app/tsconfig.json",
                "\"strict\": true,",
                "\"strict\": true,\n    \"noImplicitReturns\": true,",
            )?;
        }
    }
    Ok(())
}

fn apply_meta_glob_mutation(root: &Path, variant: usize, step_idx: usize) -> Result<(), String> {
    match variant % 3 {
        0 => replace_once(root, "lang/glob-dir/item-a.ts", "val = 2", "val = 9"),
        1 => fs::write(
            root.join(format!("lang/glob-dir/item-added-{step_idx}.ts")),
            "export const val = 9;\n",
        )
        .map_err(|e| format!("write glob added file: {e}")),
        _ => fs::remove_file(root.join("lang/glob-dir/item-b.ts"))
            .map_err(|e| format!("remove glob item-b.ts: {e}")),
    }
}

fn apply_sql_mutation(
    root: &Path,
    variant: usize,
    applied: &mut AppliedMutation,
) -> Result<(), String> {
    match variant % 3 {
        0 => {
            fs::write(
                root.join("sql-migrations/sql/002_accounts.sql"),
                "ALTER TABLE public.accounts ADD COLUMN note TEXT;\n-- BREAK_ACCOUNTS\n",
            )
            .map_err(|e| format!("write 002_accounts.sql: {e}"))?;
            applied
                .expected_skipped_tasks
                .push("sql-audits:test".to_owned());
        }
        1 => {
            fs::write(
                root.join("sql-migrations/sql/002_global.sql"),
                "CREATE EXTENSION IF NOT EXISTS pgcrypto;\n",
            )
            .map_err(|e| format!("write 002_global.sql: {e}"))?;
        }
        _ => {
            fs::write(
                root.join("sql-migrations/sql/002_unmapped.sql"),
                "ALTER TABLE public.unmapped_ledger ADD COLUMN x INT;\n-- BREAK_MIGRATION BREAK_AUDITS\n",
            )
            .map_err(|e| format!("write 002_unmapped.sql: {e}"))?;
        }
    }
    Ok(())
}

fn apply_lockfile_mutation(
    root: &Path,
    variant: usize,
    applied: &mut AppliedMutation,
) -> Result<(), String> {
    let lock_path = root.join("package-lock.json");
    let raw = fs::read_to_string(&lock_path).map_err(|e| format!("read package-lock.json: {e}"))?;
    let mut parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse package-lock.json: {e}"))?;
    let packages = parsed
        .get_mut("packages")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| "package-lock.json missing packages object".to_owned())?;
    match variant % 4 {
        0 => {
            set_pkg_version(packages, "node_modules/dst-alpha-dep", "1.0.1")?;
            replace_once(
                root,
                "node_modules/dst-alpha-dep/index.js",
                "alphaVal = 2",
                "alphaVal = 9",
            )?;
            applied
                .expected_skipped_tasks
                .push("lock-beta:test".to_owned());
        }
        1 => {
            set_pkg_version(packages, "node_modules/dst-alpha-leaf", "1.0.1")?;
            replace_once(
                root,
                "node_modules/dst-alpha-dep/index.js",
                "alphaVal = 2",
                "alphaVal = 9",
            )?;
            applied
                .expected_skipped_tasks
                .push("lock-beta:test".to_owned());
        }
        2 => {
            set_pkg_version(packages, "node_modules/typescript", "5.9.0")?;
            replace_once(
                root,
                "node_modules/dst-beta-dep/index.js",
                "betaVal = 3",
                "betaVal = 9",
            )?;
        }
        _ => {
            packages.insert(
                "node_modules/dst-unused-pkg".to_owned(),
                serde_json::json!({ "version": "1.0.0" }),
            );
            applied
                .expected_skipped_tasks
                .push("lock-alpha:test".to_owned());
            applied
                .expected_skipped_tasks
                .push("lock-beta:test".to_owned());
            applied.expected_skipped_tasks.push("ui:test".to_owned());
        }
    }
    let updated = serde_json::to_string_pretty(&parsed)
        .map_err(|e| format!("serialize package-lock.json: {e}"))?;
    fs::write(&lock_path, format!("{updated}\n"))
        .map_err(|e| format!("write package-lock.json: {e}"))
}

fn set_pkg_version(
    packages: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    version: &str,
) -> Result<(), String> {
    let entry = packages
        .get_mut(key)
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| format!("package-lock.json missing {key}"))?;
    entry.insert(
        "version".to_owned(),
        serde_json::Value::String(version.to_owned()),
    );
    Ok(())
}

fn apply_tsx_asset_mutation(root: &Path, variant: usize) -> Result<(), String> {
    match variant % 3 {
        0 => replace_once(
            root,
            "lang/Widget.tsx",
            "<div>{badgeRaw.trim()}|{themeCss.trim()}</div>",
            "<section>{badgeRaw.trim()}|{themeCss.trim()}</section>",
        ),
        1 => replace_once(root, "lang/badge.svg", "<svg>ok</svg>", "<svg>broken</svg>"),
        _ => replace_once(root, "lang/theme.css", "color: green;", "color: red;"),
    }
}

fn apply_vitest_mutation(root: &Path, variant: usize) -> Result<(), String> {
    match variant % 3 {
        0 => replace_once(root, "vitest-proj/vitest-setup.ts", "\"ok\"", "\"broken\""),
        1 => replace_once(root, "vitest-proj/mock-dep.ts", "depVal = 2", "depVal = 9"),
        _ => {
            fs::write(
                root.join("vitest-proj/vitest-setup-alt.ts"),
                "(globalThis as Record<string, unknown>).__DST_VITEST_SETUP__ = \"broken\";\n",
            )
            .map_err(|e| format!("write vitest-setup-alt.ts: {e}"))?;
            replace_once(
                root,
                "vitest-proj/vitest.config.ts",
                "\"./vitest-setup.ts\"",
                "\"./vitest-setup-alt.ts\"",
            )
        }
    }
}
