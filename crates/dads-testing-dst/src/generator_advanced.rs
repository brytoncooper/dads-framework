//! Advanced workspace modules & tests covering JS/TS constructs, FS APIs, resolution, and builds.

use crate::model::WorkspaceShape;
use crate::node_oracle::OracleTestSpec;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

pub struct AdvancedTests {
    pub oracle_tests: Vec<OracleTestSpec>,
    pub task_tests: BTreeMap<String, Vec<String>>,
}

pub fn write_advanced_workspace(
    root: &Path,
    external_flag_path: &Path,
    shape: &WorkspaceShape,
) -> Result<AdvancedTests, String> {
    write_lang_core_constructs(root)?;
    write_lang_side_effect_constructs(root)?;
    write_adv_unit_tests(root)?;
    write_adv_fs_and_resolution_tests(root)?;
    write_build_chain_and_special_tests(root)?;
    let _ = shape;

    let adv_files = vec![
        "adv/default-exp.test.ts".to_owned(),
        "adv/ns-escaped.test.ts".to_owned(),
        "adv/cjs.test.ts".to_owned(),
        "adv/multi-hop.test.ts".to_owned(),
        "adv/enums.test.ts".to_owned(),
        "adv/overloads.test.ts".to_owned(),
        "adv/extends.test.ts".to_owned(),
        "adv/static-field.test.ts".to_owned(),
        "adv/decls.test.ts".to_owned(),
        "adv/side-effects.test.ts".to_owned(),
        "adv/registry-and-pure.test.ts".to_owned(),
        "adv/cycle-lazy-asi.test.ts".to_owned(),
        "adv/helper-fs.test.ts".to_owned(),
        "adv/fs-apis.test.ts".to_owned(),
        "adv/resolution.test.ts".to_owned(),
    ];

    let mut oracle_tests = Vec::new();
    for file in &adv_files {
        oracle_tests.push(OracleTestSpec {
            file: file.clone(),
            setup_file: None,
            env: BTreeMap::new(),
        });
    }
    let mut always_env = BTreeMap::new();
    always_env.insert(
        "DST_EXTERNAL_FLAG_PATH".to_owned(),
        external_flag_path.to_string_lossy().into_owned(),
    );
    oracle_tests.push(OracleTestSpec {
        file: "adv-always/always.test.ts".to_owned(),
        setup_file: None,
        env: always_env,
    });
    let mut mode_env = BTreeMap::new();
    mode_env.insert("DST_MODE".to_owned(), "safe".to_owned());
    oracle_tests.push(OracleTestSpec {
        file: "adv-env/env-args.test.ts".to_owned(),
        setup_file: None,
        env: mode_env,
    });
    oracle_tests.push(OracleTestSpec {
        file: "build-consumer/check.test.ts".to_owned(),
        setup_file: None,
        env: BTreeMap::new(),
    });

    let mut task_tests = BTreeMap::new();
    task_tests.insert("adv:test".to_owned(), adv_files);
    task_tests.insert(
        "adv-always:test".to_owned(),
        vec!["adv-always/always.test.ts".to_owned()],
    );
    task_tests.insert(
        "adv-env:test".to_owned(),
        vec!["adv-env/env-args.test.ts".to_owned()],
    );
    task_tests.insert(
        "build-consumer:test".to_owned(),
        vec!["build-consumer/check.test.ts".to_owned()],
    );

    Ok(AdvancedTests {
        oracle_tests,
        task_tests,
    })
}

fn write_file(root: &Path, rel: &str, content: &str) -> Result<(), String> {
    let full = root.join(rel);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create dir {}: {error}", parent.display()))?;
    }
    fs::write(&full, content).map_err(|error| format!("write {rel}: {error}"))
}

fn write_lang_core_constructs(root: &Path) -> Result<(), String> {
    write_file(
        root,
        "lang/default-exp.ts",
        "export default function defaultCalc(n: number): number { return n * 2; }\n",
    )?;
    write_file(
        root,
        "lang/ns-source.ts",
        "export const nsAlpha = 2;\nexport const nsBeta = 3;\n",
    )?;
    write_file(
        root,
        "lang/legacy.cjs",
        "module.exports = { legacyRate: 2 };\n",
    )?;
    write_file(root, "lang/hop-a.ts", "export const origVal = 2;\n")?;
    write_file(
        root,
        "lang/hop-b.ts",
        "export { origVal as midVal } from \"./hop-a.ts\";\n",
    )?;
    write_file(
        root,
        "lang/hop-c.ts",
        "export { midVal as finalVal } from \"./hop-b.ts\";\n",
    )?;
    write_file(
        root,
        "lang/enums.ts",
        "export enum StatusCode {\n  Active = 1,\n  Inactive = 0,\n}\n",
    )?;
    write_file(
        root,
        "lang/overloads.ts",
        "export function doubleVal(x: number): number;\nexport function doubleVal(x: string): string;\nexport function doubleVal(x: number | string): number | string {\n  return typeof x === \"number\" ? x * 2 : x + x;\n}\n",
    )?;
    write_file(
        root,
        "lang/base-class.ts",
        "export class BaseCalc {\n  baseFactor(): number {\n    return 2;\n  }\n}\n",
    )?;
    write_file(
        root,
        "lang/child-class.ts",
        "import { BaseCalc } from \"./base-class.ts\";\nexport class ChildCalc extends BaseCalc {\n  run(n: number): number {\n    return n * this.baseFactor();\n  }\n}\n",
    )?;
    write_file(
        root,
        "lang/static-field.ts",
        "const st = { v: 2 };\nfunction setSt(n: number): number { st.v = n; return n; }\nexport class StaticHolder {\n  static initField = setSt(2);\n}\nexport const readStaticFieldState = (): number => st.v;\n",
    )?;
    write_file(
        root,
        "lang/decls.ts",
        "const pair = { a: 2, b: 3 };\nexport const { a: destA, b: destB } = pair;\nexport const multiA = 2, multiB = 3;\nconst hiddenVal = 2;\nexport { hiddenVal as exposedVal };\nexport let mutableRate = 2;\nexport function readMutableRate(): number { return mutableRate; }\n",
    )
}

fn write_lang_side_effect_constructs(root: &Path) -> Result<(), String> {
    write_file(
        root,
        "lang/computed-prop.ts",
        "const cp = { v: 2 };\nfunction keyFn(n: number): string { cp.v = n; return \"k\"; }\nexport const compObj = { [keyFn(2)]: 1 };\nexport const readCompState = (): number => cp.v;\n",
    )?;
    write_file(
        root,
        "lang/zero-export-se.ts",
        "(globalThis as Record<string, unknown>).__DST_ZERO_EXP__ = 2;\n",
    )?;
    write_file(
        root,
        "lang/required-init.ts",
        "(globalThis as Record<string, unknown>).__DST_REQ_INIT__ = \"ready\";\n",
    )?;
    write_file(
        root,
        "lang/se-bridge.ts",
        "import \"./zero-export-se.ts\";\nimport \"./required-init.ts\";\nexport const readBridge = (): string => `${String((globalThis as Record<string, unknown>).__DST_ZERO_EXP__)}:${String((globalThis as Record<string, unknown>).__DST_REQ_INIT__)}`;\n",
    )?;
    write_file(
        root,
        "lang/top-await.ts",
        "const aw = { v: 2 };\nasync function loadAw(n: number): Promise<number> { aw.v = n; return n; }\nexport const awReady = await loadAw(2);\nexport const readTopAwait = (): number => aw.v;\n",
    )?;
    write_file(
        root,
        "lang/registry.ts",
        "export const registry = new Map<string, number>([[\"tax\", 2]]);\nexport const readRegistry = (): number => registry.get(\"tax\") ?? 0;\n",
    )?;
    write_file(
        root,
        "lang/registry-mutator.ts",
        "import { registry } from \"./registry.ts\";\nexport const regMarker = registry.set(\"tax\", 2);\nexport const regUnrelated = 1;\n",
    )?;
    write_file(
        root,
        "lang/pure-trap.ts",
        "const pt = { v: 2 };\nfunction impureArg(n: number): number { pt.v = n; return n; }\nfunction wrapPure<T>(x: T): T { return x; }\nexport const pureAnnotated = /*#__PURE__*/ wrapPure(impureArg(2));\nexport const readPureTrap = (): number => pt.v;\n",
    )?;
    write_file(
        root,
        "lang/cycle-a.ts",
        "import { cycleB } from \"./cycle-b.ts\";\nexport const cycleBase = 2;\nexport const cycleA = (n: number): number => cycleB(n);\n",
    )?;
    write_file(
        root,
        "lang/cycle-b.ts",
        "import { cycleBase } from \"./cycle-a.ts\";\nexport const cycleB = (n: number): number => n * cycleBase;\n",
    )?;
    write_file(root, "lang/lazy.ts", "export const lazyFactor = 2;\n")?;
    write_file(
        root,
        "lang/asi.ts",
        "export function asiReturn(): number | undefined {\n  return 2;\n}\n",
    )?;
    write_file(
        root,
        "lang/js-ext-target.ts",
        "export const jsExtVal = 2;\n",
    )?;
    write_file(
        root,
        "lang/shadow/index.ts",
        "export const shadowVal = 1;\n",
    )?;
    write_file(
        root,
        "lang/subpath-target.ts",
        "export const subpathVal = 2;\n",
    )
}

fn write_adv_unit_tests(root: &Path) -> Result<(), String> {
    write_file(
        root,
        "adv/default-exp.test.ts",
        "import defaultCalc from \"../lang/default-exp.ts\";\nif (defaultCalc(3) !== 6) throw new Error(\"default\");\n",
    )?;
    write_file(
        root,
        "adv/ns-escaped.test.ts",
        "import * as ns from \"../lang/ns-source.ts\";\nconst sum = Object.values(ns).reduce((a, b) => a + b, 0);\nif (sum !== 5) throw new Error(`ns=${sum}`);\n",
    )?;
    write_file(
        root,
        "adv/cjs.test.ts",
        "import { createRequire } from \"node:module\";\nconst require = createRequire(import.meta.url);\nconst legacy = require(\"../lang/legacy.cjs\");\nif (legacy.legacyRate !== 2) throw new Error(`cjs=${legacy.legacyRate}`);\n",
    )?;
    write_file(
        root,
        "adv/multi-hop.test.ts",
        "import { finalVal as renamed } from \"../lang/hop-c.ts\";\nif (renamed !== 2) throw new Error(`hop=${renamed}`);\n",
    )?;
    write_file(
        root,
        "adv/enums.test.ts",
        "import { StatusCode } from \"../lang/enums.ts\";\nif (StatusCode.Active !== 1) throw new Error(`enum=${StatusCode.Active}`);\n",
    )?;
    write_file(
        root,
        "adv/overloads.test.ts",
        "import { doubleVal } from \"../lang/overloads.ts\";\nif (doubleVal(3) !== 6) throw new Error(`overload=${doubleVal(3)}`);\n",
    )?;
    write_file(
        root,
        "adv/extends.test.ts",
        "import { ChildCalc } from \"../lang/child-class.ts\";\nif (new ChildCalc().run(3) !== 6) throw new Error(\"extends\");\n",
    )?;
    write_file(
        root,
        "adv/static-field.test.ts",
        "import { readStaticFieldState } from \"../lang/static-field.ts\";\nif (readStaticFieldState() !== 2) throw new Error(`staticField=${readStaticFieldState()}`);\n",
    )?;
    write_file(
        root,
        "adv/decls.test.ts",
        "import { destA, multiA, exposedVal, readMutableRate } from \"../lang/decls.ts\";\nif (destA !== 2 || multiA !== 2 || exposedVal !== 2 || readMutableRate() !== 2) throw new Error(\"decls\");\n",
    )?;
    write_file(
        root,
        "adv/side-effects.test.ts",
        "import { readCompState } from \"../lang/computed-prop.ts\";\nimport { readBridge } from \"../lang/se-bridge.ts\";\nimport { readTopAwait } from \"../lang/top-await.ts\";\nif (readCompState() !== 2 || readBridge() !== \"2:ready\" || readTopAwait() !== 2) throw new Error(`se=${readCompState()}|${readBridge()}|${readTopAwait()}`);\n",
    )?;
    write_file(
        root,
        "adv/registry-and-pure.test.ts",
        "import { readRegistry } from \"../lang/registry.ts\";\nimport { regUnrelated } from \"../lang/registry-mutator.ts\";\nimport { readPureTrap } from \"../lang/pure-trap.ts\";\nif (regUnrelated !== 1 || readRegistry() !== 2 || readPureTrap() !== 2) throw new Error(`reg=${readRegistry()} pure=${readPureTrap()}`);\n",
    )?;
    write_file(
        root,
        "adv/cycle-lazy-asi.test.ts",
        "import { cycleA } from \"../lang/cycle-a.ts\";\nimport { asiReturn } from \"../lang/asi.ts\";\nconst { lazyFactor } = await import(\"../lang/lazy.ts\");\nif (cycleA(3) !== 6 || lazyFactor !== 2 || asiReturn() !== 2) throw new Error(\"cycle-lazy-asi\");\n",
    )
}

fn write_adv_fs_and_resolution_tests(root: &Path) -> Result<(), String> {
    write_file(
        root,
        "adv/helper-fs.ts",
        "import { readFileSync } from \"node:fs\";\nexport function loadHelperDiskLimit(): number {\n  return JSON.parse(readFileSync(new URL(\"../settings/helper-disk.json\", import.meta.url), \"utf8\")).limit;\n}\n",
    )?;
    write_file(
        root,
        "adv/helper-fs.test.ts",
        "import { loadHelperDiskLimit } from \"./helper-fs.ts\";\nif (loadHelperDiskLimit() !== 5) throw new Error(\"helper-fs\");\n",
    )?;
    write_file(
        root,
        "adv/fs-apis.test.ts",
        r#"import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const asyncCfg = JSON.parse(await readFile(fileURLToPath(new URL("../settings/async-limit.json", import.meta.url)), "utf8"));
if (asyncCfg.limit !== 5) throw new Error(`async=${asyncCfg.limit}`);
if (!existsSync(join(root, "settings/sentinel.txt"))) throw new Error("sentinel missing");
const nestedDir = join(root, "settings/nested-rules");
const entries = readdirSync(nestedDir, { recursive: true, withFileTypes: true });
for (const entry of entries) {
  if (entry.isFile()) {
    const full = join(entry.parentPath, entry.name);
    if (readFileSync(full, "utf8").includes("FORBIDDEN")) throw new Error(`nested=${entry.name}`);
  }
}
"#,
    )?;
    write_file(
        root,
        "adv/resolution.test.ts",
        "import { jsExtVal } from \"../lang/js-ext-target.js\";\nimport { shadowVal } from \"../lang/shadow\";\nimport { subpathVal } from \"#subpath\";\nif (jsExtVal !== 2 || shadowVal !== 1 || subpathVal !== 2) throw new Error(`res=${jsExtVal},${shadowVal},${subpathVal}`);\n",
    )
}

fn write_build_chain_and_special_tests(root: &Path) -> Result<(), String> {
    write_file(
        root,
        "adv-always/always.test.ts",
        "import { readFileSync } from \"node:fs\";\nconst target = process.env.DST_EXTERNAL_FLAG_PATH;\nif (!target) throw new Error(\"missing DST_EXTERNAL_FLAG_PATH\");\nif (readFileSync(target, \"utf8\").trim() !== \"ok\") throw new Error(\"external flag changed\");\n",
    )?;
    write_file(
        root,
        "adv-env/env-args.test.ts",
        "if (process.env.DST_MODE !== \"safe\") throw new Error(`mode=${String(process.env.DST_MODE)}`);\n",
    )?;
    write_file(root, "build-dep/src/val.ts", "export const buildVal = 2;\n")?;
    write_file(
        root,
        "build-dep/build.mjs",
        "import { mkdirSync, readFileSync, writeFileSync } from \"node:fs\";\nconst src = readFileSync(\"build-dep/src/val.ts\", \"utf8\");\nconst m = src.match(/buildVal\\s*=\\s*(\\d+)/);\nconst val = m ? Number(m[1]) : -1;\nmkdirSync(\"build-dep/dist\", { recursive: true });\nwriteFileSync(\"build-dep/dist/out.json\", JSON.stringify({ val }) + \"\\n\");\n",
    )?;
    write_file(
        root,
        "build-consumer/check.test.ts",
        "import { readFileSync } from \"node:fs\";\nimport { join, resolve } from \"node:path\";\nconst root = resolve(import.meta.dirname, \"..\");\nconst out = JSON.parse(readFileSync(join(root, \"build-dep/dist/out.json\"), \"utf8\"));\nif (out.val !== 2) throw new Error(`buildOut=${out.val}`);\n",
    )
}
