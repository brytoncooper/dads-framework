//! Section B (#71-#78) DST workspace fixtures: TypeScript typecheck + ambient `.d.ts`,
//! `import.meta.glob`, SQL migration domains, `package-lock.json` v3, `.tsx` + `?raw`/`.svg`/`.css`,
//! Vitest `vi.mock`/`vi.hoisted`/`vitest.config.ts`, and module-boundary projects.

use crate::node_oracle::OracleTestSpec;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

pub struct SubsystemTests {
    pub adv_test_files: Vec<String>,
    pub extra_oracle_tests: Vec<OracleTestSpec>,
    pub extra_task_tests: BTreeMap<String, Vec<String>>,
}

pub fn write_subsystems_workspace(root: &Path) -> Result<SubsystemTests, String> {
    write_typecheck_fixtures(root)?;
    write_meta_glob_and_tsx_fixtures(root)?;
    write_sql_fixtures(root)?;
    write_lockfile_fixtures(root)?;
    write_vitest_and_boundaries_fixtures(root)?;
    reset_subsystems_untracked_baseline(root)?;

    let adv_test_files = vec![
        "adv/meta-glob.test.ts".to_owned(),
        "adv/tsx-assets.test.ts".to_owned(),
    ];
    let mut extra_oracle_tests = Vec::new();
    let mut extra_task_tests = BTreeMap::new();
    let standalone = [
        ("typecheck-app:test", "typecheck-app/runtime.test.ts"),
        ("sql-migrations:test", "sql-migrations/runner.test.ts"),
        ("sql-accounts:test", "sql-accounts/accounts.test.ts"),
        ("sql-audits:test", "sql-audits/audits.test.ts"),
        ("lock-alpha:test", "lock-alpha/alpha.test.ts"),
        ("lock-beta:test", "lock-beta/beta.test.ts"),
        ("vitest-proj:test", "vitest-proj/mocked.test.ts"),
    ];
    for (task_id, file) in standalone {
        extra_oracle_tests.push(OracleTestSpec {
            file: file.to_owned(),
            setup_file: None,
            env: BTreeMap::new(),
        });
        extra_task_tests.insert(task_id.to_owned(), vec![file.to_owned()]);
    }
    Ok(SubsystemTests {
        adv_test_files,
        extra_oracle_tests,
        extra_task_tests,
    })
}

/// Restores gitignored `node_modules/dst-*` fixtures after `git reset --hard && git clean -fd`.
pub fn reset_subsystems_untracked_baseline(root: &Path) -> Result<(), String> {
    write_file(
        root,
        "node_modules/dst-alpha-dep/package.json",
        "{\"name\":\"dst-alpha-dep\",\"version\":\"1.0.0\",\"type\":\"module\",\"main\":\"./index.js\"}\n",
    )?;
    write_file(
        root,
        "node_modules/dst-alpha-dep/index.js",
        "export const alphaVal = 2;\n",
    )?;
    write_file(
        root,
        "node_modules/dst-beta-dep/package.json",
        "{\"name\":\"dst-beta-dep\",\"version\":\"1.0.0\",\"type\":\"module\",\"main\":\"./index.js\"}\n",
    )?;
    write_file(
        root,
        "node_modules/dst-beta-dep/index.js",
        "export const betaVal = 3;\n",
    )
}

fn write_typecheck_fixtures(root: &Path) -> Result<(), String> {
    write_file(
        root,
        "types-lib/contracts.ts",
        concat!(
            "export interface InvoiceRow {\n",
            "  id: string;\n",
            "  total: number;\n",
            "}\n",
            "export type Currency = \"USD\" | \"EUR\";\n",
            "export function calcNet(n: number): number;\n",
            "export function calcNet(n: number | string): number {\n",
            "  return typeof n === \"number\" ? n : Number(n);\n",
            "}\n",
        ),
    )?;
    write_file(
        root,
        "types-lib/globals.d.ts",
        concat!(
            "declare global {\n",
            "  var __DST_AMBIENT_VERSION__: number;\n",
            "}\n",
            "export {};\n",
        ),
    )?;
    write_file(
        root,
        "typecheck-app/tsconfig.json",
        concat!(
            "{\n",
            "  \"extends\": \"../tsconfig.base.json\",\n",
            "  \"compilerOptions\": {\n",
            "    \"noEmit\": true,\n",
            "    \"strict\": true,\n",
            "    \"ignoreDeprecations\": \"6.0\",\n",
            "    \"target\": \"ES2022\",\n",
            "    \"module\": \"ESNext\",\n",
            "    \"moduleResolution\": \"Bundler\",\n",
            "    \"lib\": [\"es2022\"],\n",
            "    \"types\": [],\n",
            "    \"skipLibCheck\": true,\n",
            "    \"allowImportingTsExtensions\": true\n",
            "  },\n",
            "  \"include\": [\"./**/*.ts\", \"../types-lib/**/*.ts\"]\n",
            "}\n",
        ),
    )?;
    write_file(
        root,
        "typecheck-app/consumer.ts",
        concat!(
            "import type { InvoiceRow, Currency } from \"../types-lib/contracts.ts\";\n",
            "import { calcNet } from \"../types-lib/contracts.ts\";\n",
            "export const sampleRow: InvoiceRow = { id: \"inv-1\", total: calcNet(10) };\n",
            "export const sampleCur: Currency = \"USD\";\n",
            "export const ambientVersion: number = globalThis.__DST_AMBIENT_VERSION__;\n",
            "export function checkStrict(flag: boolean): number | undefined {\n",
            "  if (flag) {\n",
            "    return 1;\n",
            "  }\n",
            "}\n",
        ),
    )?;
    write_file(
        root,
        "typecheck-app/runtime.test.ts",
        concat!(
            "import type { InvoiceRow } from \"../types-lib/contracts.ts\";\n",
            "import { calcNet } from \"../types-lib/contracts.ts\";\n",
            "const row: InvoiceRow = { id: \"inv-1\", total: calcNet(10) };\n",
            "if (row.total !== 10) throw new Error(`tc-rt=${row.total}`);\n",
        ),
    )
}

fn write_meta_glob_and_tsx_fixtures(root: &Path) -> Result<(), String> {
    write_file(root, "lang/glob-dir/item-a.ts", "export const val = 2;\n")?;
    write_file(root, "lang/glob-dir/item-b.ts", "export const val = 3;\n")?;
    write_file(
        root,
        "lang/glob-dir/ignored.skip.ts",
        "export const val = 100;\n",
    )?;
    write_file(
        root,
        "adv/meta-glob.test.ts",
        concat!(
            "const mods = import.meta.glob(\"../lang/glob-dir/*.ts\") as Record<string, () => Promise<{ val: number }>>;\n",
            "const keys = Object.keys(mods).filter((k) => !k.endsWith(\".skip.ts\")).sort();\n",
            "let sum = 0;\n",
            "for (const k of keys) {\n",
            "  const m = await mods[k]();\n",
            "  sum += m.val;\n",
            "}\n",
            "if (keys.length !== 2 || sum !== 5) throw new Error(`meta-glob len=${keys.length} sum=${sum}`);\n",
        ),
    )?;
    write_file(
        root,
        "lang/jsx-runtime.ts",
        "export const h = (tag: string, _props: Record<string, unknown> | null, ...children: unknown[]): string => `<${tag}>${children.join(\"\")}</${tag}>`;\n",
    )?;
    write_file(root, "lang/badge.svg", "<svg>ok</svg>\n")?;
    write_file(root, "lang/theme.css", ".badge { color: green; }\n")?;
    write_file(
        root,
        "lang/Widget.tsx",
        concat!(
            "import { h } from \"./jsx-runtime.ts\";\n",
            "import badgeRaw from \"./badge.svg?raw\";\n",
            "import themeCss from \"./theme.css\";\n",
            "export function Widget(): string {\n",
            "  return <div>{badgeRaw.trim()}|{themeCss.trim()}</div>;\n",
            "}\n",
        ),
    )?;
    write_file(
        root,
        "adv/tsx-assets.test.ts",
        concat!(
            "import { Widget } from \"../lang/Widget.tsx\";\n",
            "const rendered = Widget();\n",
            "if (rendered !== \"<div><svg>ok</svg>|.badge { color: green; }</div>\") {\n",
            "  throw new Error(`tsx=${rendered}`);\n",
            "}\n",
        ),
    )
}

fn write_sql_fixtures(root: &Path) -> Result<(), String> {
    write_file(
        root,
        "sql-migrations/sql/001_init.sql",
        "CREATE TABLE public.accounts (id INT);\nCREATE TABLE public.audits (id INT);\n",
    )?;
    write_file(
        root,
        "sql-migrations/grants/public.accounts.txt",
        "GRANT SELECT ON public.accounts TO app;\n",
    )?;
    write_file(
        root,
        "sql-migrations/runner.test.ts",
        concat!(
            "const sqlMap = ((globalThis as Record<string, unknown>).__DST_SQL_STATE__ ?? {}) as Record<string, string>;\n",
            "for (const [name, body] of Object.entries(sqlMap)) {\n",
            "  if (body.includes(\"BREAK_MIGRATION\")) throw new Error(`sql-runner=${name}`);\n",
            "}\n",
        ),
    )?;
    write_file(
        root,
        "sql-accounts/accounts.test.ts",
        concat!(
            "const sqlMap = ((globalThis as Record<string, unknown>).__DST_SQL_STATE__ ?? {}) as Record<string, string>;\n",
            "for (const [name, body] of Object.entries(sqlMap)) {\n",
            "  if (body.includes(\"BREAK_ACCOUNTS\") || body.includes(\"CREATE EXTENSION\")) throw new Error(`sql-accounts=${name}`);\n",
            "}\n",
        ),
    )?;
    write_file(
        root,
        "sql-audits/audits.test.ts",
        concat!(
            "const sqlMap = ((globalThis as Record<string, unknown>).__DST_SQL_STATE__ ?? {}) as Record<string, string>;\n",
            "for (const [name, body] of Object.entries(sqlMap)) {\n",
            "  if (body.includes(\"BREAK_AUDITS\") || body.includes(\"CREATE EXTENSION\")) throw new Error(`sql-audits=${name}`);\n",
            "}\n",
        ),
    )
}

fn write_lockfile_fixtures(root: &Path) -> Result<(), String> {
    write_file(
        root,
        "lock-alpha/alpha.test.ts",
        "import { alphaVal } from \"dst-alpha-dep\";\nif (alphaVal !== 2) throw new Error(`lock-alpha=${alphaVal}`);\n",
    )?;
    write_file(
        root,
        "lock-beta/beta.test.ts",
        "import { betaVal } from \"dst-beta-dep\";\nif (betaVal !== 3) throw new Error(`lock-beta=${betaVal}`);\n",
    )
}

fn write_vitest_and_boundaries_fixtures(root: &Path) -> Result<(), String> {
    write_file(
        root,
        "vitest-proj/vitest.config.ts",
        "export default {\n  test: {\n    setupFiles: [\"./vitest-setup.ts\"],\n  },\n};\n",
    )?;
    write_file(
        root,
        "vitest-proj/vitest-setup.ts",
        "(globalThis as Record<string, unknown>).__DST_VITEST_SETUP__ = \"ok\";\n",
    )?;
    write_file(
        root,
        "vitest-proj/mock-dep.ts",
        "export const depVal = 2;\n",
    )?;
    write_file(
        root,
        "vitest-proj/vi-shim.ts",
        "export const vi = {\n  hoisted<T>(fn: () => T): T { return fn(); },\n  mock(_spec: string, factory?: () => unknown): void { if (factory) factory(); },\n};\n",
    )?;
    write_file(
        root,
        "vitest-proj/mocked.test.ts",
        concat!(
            "import { vi } from \"./vi-shim.ts\";\n",
            "import { depVal } from \"./mock-dep.ts\";\n",
            "const expected = vi.hoisted(() => 2);\n",
            "vi.mock(\"./mock-dep.ts\", () => ({ depVal: expected }));\n",
            "if ((globalThis as Record<string, unknown>).__DST_VITEST_SETUP__ !== \"ok\") throw new Error(\"vitest-setup-broken\");\n",
            "if (depVal !== expected) throw new Error(`mock-dep=${depVal}`);\n",
        ),
    )?;
    write_file(root, "bnd-shared/util.ts", "export const sharedVal = 2;\n")?;
    write_file(root, "bnd-server/db.ts", "export const dbVal = 2;\n")?;
    write_file(
        root,
        "bnd-browser/app.ts",
        "import { sharedVal } from \"@bnd/shared\";\nexport const appVal = sharedVal;\n",
    )
}

fn write_file(root: &Path, rel: &str, content: &str) -> Result<(), String> {
    let full = root.join(rel);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create dir {}: {error}", parent.display()))?;
    }
    fs::write(&full, content).map_err(|error| format!("write {rel}: {error}"))
}
