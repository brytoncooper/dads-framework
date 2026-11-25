//! Section A (Phase 1) DST fixtures covering the 10 hardened 0.9.0 soundness & caching invariants:
//! Object.freeze(ident), implicit coercion, load-time throws/TDZ, missing-at-baseline existsSync,
//! empty-dir readdirSync, static-dir-prefix & dynamic fs helpers, extended fs/child_process APIs,
//! gitignored glob impact.paths, upstream package.json exports, and gitignored .env.test configs.

use crate::node_oracle::OracleTestSpec;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

pub struct SectionATests {
    pub adv_test_files: Vec<String>,
    pub extra_oracle_tests: Vec<OracleTestSpec>,
    pub extra_task_tests: BTreeMap<String, Vec<String>>,
}

pub fn write_section_a_workspace(root: &Path) -> Result<SectionATests, String> {
    write_purity_and_pkg_fixtures(root)?;
    write_fs_and_config_fixtures(root)?;
    reset_section_a_untracked_baseline(root)?;

    let adv_test_files = vec![
        "adv/sec-a-purity.test.ts".to_owned(),
        "adv/sec-a-fs.test.ts".to_owned(),
        "adv/sec-a-ext-fs.test.ts".to_owned(),
        "adv/sec-a-pkg.test.ts".to_owned(),
        "adv/sec-a-dotenv.test.ts".to_owned(),
    ];

    let mut extra_oracle_tests = vec![OracleTestSpec {
        file: "adv-dyn-fs/dyn-fs.test.ts".to_owned(),
        setup_file: None,
        env: BTreeMap::new(),
    }];
    extra_oracle_tests.push(OracleTestSpec {
        file: "impact-consumer/ignored-glob.test.ts".to_owned(),
        setup_file: None,
        env: BTreeMap::new(),
    });

    let mut extra_task_tests = BTreeMap::new();
    extra_task_tests.insert(
        "adv-dyn-fs:test".to_owned(),
        vec!["adv-dyn-fs/dyn-fs.test.ts".to_owned()],
    );
    Ok(SectionATests {
        adv_test_files,
        extra_oracle_tests,
        extra_task_tests,
    })
}

/// Restores untracked/gitignored baseline state after `git reset --hard && git clean -fd`.
pub fn reset_section_a_untracked_baseline(root: &Path) -> Result<(), String> {
    let empty_scan = root.join("settings/empty-scan");
    let _ = fs::remove_dir_all(&empty_scan);
    fs::create_dir_all(&empty_scan).map_err(|e| format!("mkdir empty-scan: {e}"))?;
    let sentinel = root.join("settings/sentinel-missing.json");
    let _ = fs::remove_file(&sentinel);
    write_file(
        root,
        "settings/generated-ignored/schema.json",
        "{\"ok\":true}\n",
    )?;
    write_file(root, ".env.test", "TEST_MULT=2\n")?;
    Ok(())
}

fn write_purity_and_pkg_fixtures(root: &Path) -> Result<(), String> {
    write_file(
        root,
        "lang/freeze-shared.ts",
        concat!(
            "export const sharedCfg = { rate: 2 };\n",
            "export const frozenUnused = Object.freeze({ ok: 1 });\n",
            "export function getCfgRate(): number {\n",
            "  sharedCfg.rate = 3;\n",
            "  return sharedCfg.rate;\n",
            "}\n",
        ),
    )?;
    write_file(
        root,
        "lang/coercion.ts",
        concat!(
            "let side = 2;\n",
            "const box = {\n",
            "  [Symbol.toPrimitive]() { side = 9; return \"ok\"; },\n",
            "};\n",
            "export const tag = `${\"safe\"}`;\n",
            "export const getCoerced = (): number => side;\n",
        ),
    )?;
    write_file(
        root,
        "lang/load-throw.ts",
        concat!(
            "export const pat = new RegExp(\"^[a-z]+$\", \"i\");\n",
            "export const okLoad = (): number => 2;\n",
        ),
    )?;
    write_file(
        root,
        "lang-pkg/package.json",
        "{\n  \"name\": \"@dst/lang-pkg\",\n  \"type\": \"module\",\n  \"exports\": {\n    \".\": \"./a.ts\"\n  }\n}\n",
    )?;
    write_file(root, "lang-pkg/a.ts", "export const pkgVal = 2;\n")?;
    write_file(root, "lang-pkg/b.ts", "export const pkgVal = 9;\n")?;
    write_file(
        root,
        "lang/pkg-consumer.ts",
        "import { pkgVal } from \"../lang-pkg/a.ts\";\nexport const readPkgVal = (): number => pkgVal;\n",
    )?;
    write_file(
        root,
        "adv/sec-a-purity.test.ts",
        concat!(
            "import { getCfgRate } from \"../lang/freeze-shared.ts\";\n",
            "import { getCoerced } from \"../lang/coercion.ts\";\n",
            "import { okLoad } from \"../lang/load-throw.ts\";\n",
            "if (getCfgRate() !== 3 || getCoerced() !== 2 || okLoad() !== 2) throw new Error(\"sec-a-purity\");\n",
        ),
    )?;
    write_file(
        root,
        "adv/sec-a-pkg.test.ts",
        concat!(
            "import { readFileSync } from \"node:fs\";\n",
            "import { readPkgVal } from \"../lang/pkg-consumer.ts\";\n",
            "const pkg = JSON.parse(readFileSync(new URL(\"../lang-pkg/package.json\", import.meta.url), \"utf8\"));\n",
            "const target = pkg.exports[\".\"] === \"./a.ts\" ? readPkgVal() : 9;\n",
            "if (target !== 2) throw new Error(\"sec-a-pkg\");\n",
        ),
    )?;
    Ok(())
}

fn write_fs_and_config_fixtures(root: &Path) -> Result<(), String> {
    write_file(root, "settings/dyn-fixtures/item.json", "{\"factor\":2}\n")?;
    write_file(root, "settings/dyn-secret.json", "{\"secret\":2}\n")?;
    write_file(root, "settings/access-target.json", "{\"v\":2}\n")?;
    write_file(
        root,
        "settings/check-script.mjs",
        "process.stdout.write(\"2\");\n",
    )?;
    write_file(
        root,
        "lang/fs-prefix-helper.ts",
        concat!(
            "import { readFileSync } from \"node:fs\";\n",
            "import { join } from \"node:path\";\n",
            "import { fileURLToPath } from \"node:url\";\n",
            "const FIXTURE_DIR = fileURLToPath(new URL(\"../settings/dyn-fixtures\", import.meta.url));\n",
            "export function readPrefixFixture(name: string): number {\n",
            "  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), \"utf8\")).factor;\n",
            "}\n",
        ),
    )?;
    write_file(
        root,
        "lang/fs-unresolved-helper.ts",
        concat!(
            "import { readFileSync } from \"node:fs\";\n",
            "export function readDynamicPath(p: string): string {\n",
            "  return readFileSync(p, \"utf8\");\n",
            "}\n",
        ),
    )?;
    write_file(
        root,
        "adv/sec-a-fs.test.ts",
        concat!(
            "import { existsSync, readdirSync } from \"node:fs\";\n",
            "import { readPrefixFixture } from \"../lang/fs-prefix-helper.ts\";\n",
            "if (existsSync(new URL(\"../settings/sentinel-missing.json\", import.meta.url))) throw new Error(\"sentinel-created\");\n",
            "const emptyEntries = readdirSync(new URL(\"../settings/empty-scan\", import.meta.url));\n",
            "if (emptyEntries.length !== 0) throw new Error(\"empty-scan-changed\");\n",
            "if (readPrefixFixture(\"item.json\") !== 2) throw new Error(\"prefix-fixture\");\n",
        ),
    )?;
    write_file(
        root,
        "adv/sec-a-ext-fs.test.ts",
        concat!(
            "import { accessSync, createReadStream } from \"node:fs\";\n",
            "import { execFileSync } from \"node:child_process\";\n",
            "import { fileURLToPath } from \"node:url\";\n",
            "accessSync(new URL(\"../settings/access-target.json\", import.meta.url));\n",
            "const chunks: Buffer[] = [];\n",
            "for await (const c of createReadStream(new URL(\"../settings/access-target.json\", import.meta.url))) chunks.push(Buffer.from(c));\n",
            "if (JSON.parse(Buffer.concat(chunks).toString(\"utf8\")).v !== 2) throw new Error(\"stream-read\");\n",
            "const out = execFileSync(process.execPath, [fileURLToPath(new URL(\"../settings/check-script.mjs\", import.meta.url))], { encoding: \"utf8\" });\n",
            "if (out.trim() !== \"2\") throw new Error(\"exec-script\");\n",
        ),
    )?;
    write_file(
        root,
        "adv/sec-a-dotenv.test.ts",
        concat!(
            "import { readFileSync } from \"node:fs\";\n",
            "const raw = readFileSync(new URL(\"../.env.test\", import.meta.url), \"utf8\").trim();\n",
            "if (raw !== \"TEST_MULT=2\") throw new Error(\"dotenv-changed\");\n",
        ),
    )?;
    write_file(
        root,
        "adv-dyn-fs/dyn-fs.test.ts",
        concat!(
            "import { resolve } from \"node:path\";\n",
            "import { fileURLToPath } from \"node:url\";\n",
            "import { readDynamicPath } from \"../lang/fs-unresolved-helper.ts\";\n",
            "const envPath = process.env.DST_SECRET_FIXTURE;\n",
            "const target = envPath\n",
            "  ? resolve(process.cwd(), envPath)\n",
            "  : fileURLToPath(new URL([\"..\", \"settings\", \"dyn-secret.json\"].join(\"/\"), import.meta.url));\n",
            "if (JSON.parse(readDynamicPath(target)).secret !== 2) throw new Error(\"dyn-secret\");\n",
        ),
    )?;
    write_file(
        root,
        "impact-consumer/ignored-glob.test.ts",
        concat!(
            "import { readFileSync } from \"node:fs\";\n",
            "const data = JSON.parse(readFileSync(new URL(\"../settings/generated-ignored/schema.json\", import.meta.url), \"utf8\"));\n",
            "if (data.ok !== true) throw new Error(\"ignored-glob-changed\");\n",
        ),
    )?;
    Ok(())
}

fn write_file(root: &Path, rel: &str, content: &str) -> Result<(), String> {
    let full = root.join(rel);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create dir {}: {error}", parent.display()))?;
    }
    fs::write(&full, content).map_err(|error| format!("write {}: {error}", full.display()))
}
