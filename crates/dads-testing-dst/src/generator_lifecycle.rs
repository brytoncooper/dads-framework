//! Section D (#86-#95) DST fixtures: Next.js special path characters, case-only renames,
//! file delete/mv/hunks, CRLF/BOM/binary/chmod fixtures, and same-size/same-ms + env drift.

use crate::node_oracle::OracleTestSpec;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

pub struct LifecycleTests {
    pub adv_test_files: Vec<String>,
    pub extra_oracle_tests: Vec<OracleTestSpec>,
    pub extra_task_tests: BTreeMap<String, Vec<String>>,
}

pub fn write_lifecycle_workspace(root: &Path) -> Result<LifecycleTests, String> {
    write_nextjs_special_paths(root)?;
    write_rename_delete_fixtures(root)?;
    write_encoding_and_same_size_fixtures(root)?;

    let adv_test_files = vec![
        "adv/case-rename.test.ts".to_owned(),
        "adv/file-lifecycle.test.ts".to_owned(),
    ];
    let next_test = "next-app/app/(auth)/[id]/[...slug]/page.test.ts".to_owned();
    let cache_tests = vec![
        "adv-cache/encoding.test.ts".to_owned(),
        "adv-cache/same-size-env.test.ts".to_owned(),
    ];
    let mut extra_oracle_tests = vec![OracleTestSpec {
        file: next_test.clone(),
        setup_file: None,
        env: BTreeMap::new(),
    }];
    for file in &cache_tests {
        extra_oracle_tests.push(OracleTestSpec {
            file: file.clone(),
            setup_file: None,
            env: BTreeMap::new(),
        });
    }
    let mut extra_task_tests = BTreeMap::new();
    extra_task_tests.insert("next-app:test".to_owned(), vec![next_test]);
    extra_task_tests.insert("adv-cache:test".to_owned(), cache_tests);
    Ok(LifecycleTests {
        adv_test_files,
        extra_oracle_tests,
        extra_task_tests,
    })
}

fn write_nextjs_special_paths(root: &Path) -> Result<(), String> {
    write_file(
        root,
        "next-app/app/(auth)/[id]/[...slug]/@slot/data file.ts",
        "export const routeVal = 2;\n",
    )?;
    write_file(
        root,
        "next-app/app/(auth)/[id]/[...slug]/@slot/café.ts",
        "export const cafeVal = 3;\n",
    )?;
    write_file(
        root,
        "next-app/app/(auth)/[id]/[...slug]/@slot/meta [v1].json",
        "{\"ok\":true}\n",
    )?;
    write_file(
        root,
        "next-app/app/(auth)/[id]/[...slug]/page.test.ts",
        concat!(
            "import { routeVal } from \"./@slot/data file.ts\";\n",
            "import { cafeVal } from \"./@slot/café.ts\";\n",
            "import { readFileSync } from \"node:fs\";\n",
            "const cfg = JSON.parse(readFileSync(new URL(\"./@slot/meta [v1].json\", import.meta.url), \"utf8\"));\n",
            "if (routeVal !== 2 || cafeVal !== 3 || cfg.ok !== true) throw new Error(\"nextjs-path\");\n",
        ),
    )
}

fn write_rename_delete_fixtures(root: &Path) -> Result<(), String> {
    write_file(root, "lang/CaseTarget.ts", "export const caseVal = 2;\n")?;
    write_file(
        root,
        "adv/case-rename.test.ts",
        "import { caseVal } from \"../lang/CaseTarget.ts\";\nif (caseVal !== 2) throw new Error(`case=${caseVal}`);\n",
    )?;
    write_file(root, "lang/del-mod.ts", "export const delVal = 2;\n")?;
    write_file(
        root,
        "lang/del-hunk.ts",
        "export const keepVal = 2;\nexport const dropVal = 2;\n",
    )?;
    write_file(root, "lang/mv-src.ts", "export const mvVal = 2;\n")?;
    write_file(
        root,
        "adv/file-lifecycle.test.ts",
        concat!(
            "import { delVal } from \"../lang/del-mod.ts\";\n",
            "import { dropVal } from \"../lang/del-hunk.ts\";\n",
            "import { mvVal } from \"../lang/mv-src.ts\";\n",
            "if (delVal !== 2 || dropVal !== 2 || mvVal !== 2) throw new Error(\"lifecycle\");\n",
        ),
    )
}

fn write_encoding_and_same_size_fixtures(root: &Path) -> Result<(), String> {
    write_file(root, "settings/encoding-crlf.txt", "line1\nline2\n")?;
    write_file(root, "settings/encoding-bom.json", "{\"v\":2}\n")?;
    write_bytes(
        root,
        "settings/binary-fixture.bin",
        &[0x00, 0x01, 0x02, 0x42],
    )?;
    write_file(root, "settings/exec-flag.sh", "#!/bin/sh\necho ok\n")?;
    set_file_mode(root.join("settings/exec-flag.sh").as_path(), 0o644)?;

    write_file(
        root,
        "adv-cache/encoding.test.ts",
        concat!(
            "import { readFileSync, statSync } from \"node:fs\";\n",
            "const crlfText = readFileSync(new URL(\"../settings/encoding-crlf.txt\", import.meta.url), \"utf8\");\n",
            "if (crlfText.includes(\"\\r\\n\")) throw new Error(\"crlf-detected\");\n",
            "const bomBuf = readFileSync(new URL(\"../settings/encoding-bom.json\", import.meta.url));\n",
            "if (bomBuf[0] === 0xef || JSON.parse(bomBuf.toString(\"utf8\")).v !== 2) throw new Error(\"bom-detected\");\n",
            "const binBuf = readFileSync(new URL(\"../settings/binary-fixture.bin\", import.meta.url));\n",
            "if (binBuf[0] !== 0 || binBuf[3] !== 0x42) throw new Error(`bin=${binBuf[3]}`);\n",
            "const st = statSync(new URL(\"../settings/exec-flag.sh\", import.meta.url));\n",
            "if ((st.mode & 0o111) !== 0) throw new Error(\"chmod-exec-detected\");\n",
        ),
    )?;
    write_file(root, "lang/same-size.ts", "export const exactDigit = 2;\n")?;
    write_file(
        root,
        "adv-cache/same-size-env.test.ts",
        concat!(
            "import { exactDigit } from \"../lang/same-size.ts\";\n",
            "if (exactDigit !== 2) throw new Error(`digit=${exactDigit}`);\n",
            "if (process.env.TZ === \"Pacific/Kiritimati\") throw new Error(\"tz-drift\");\n",
            "if (process.env.NODE_ENV === \"dst-broken-env\") throw new Error(\"node-env-drift\");\n",
        ),
    )
}

#[cfg(unix)]
pub fn set_file_mode(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let perms = fs::Permissions::from_mode(mode);
    fs::set_permissions(path, perms).map_err(|e| format!("chmod {}: {e}", path.display()))
}

#[cfg(not(unix))]
pub fn set_file_mode(_path: &Path, _mode: u32) -> Result<(), String> {
    Ok(())
}

fn write_file(root: &Path, rel: &str, content: &str) -> Result<(), String> {
    write_bytes(root, rel, content.as_bytes())
}

fn write_bytes(root: &Path, rel: &str, content: &[u8]) -> Result<(), String> {
    let full = root.join(rel);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create dir {}: {error}", parent.display()))?;
    }
    fs::write(&full, content).map_err(|error| format!("write {rel}: {error}"))
}
