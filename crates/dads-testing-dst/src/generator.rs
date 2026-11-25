//! Deterministic generator of executable multi-project TypeScript workspaces for DST.

use crate::generator_manifest::write_manifest;
use crate::model::{BarrelStyle, FallbackMode, WorkspaceShape};
use crate::node_oracle::OracleTestSpec;
use crate::rng::SeededRng;
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

pub struct GeneratedWorkspace {
    pub shape: WorkspaceShape,
    pub oracle_tests: Vec<OracleTestSpec>,
    pub task_tests: BTreeMap<String, Vec<String>>,
}

pub fn pick_workspace_shape(seed: u64, rng: &mut SeededRng) -> WorkspaceShape {
    let fallback_roll = rng.range_usize(100);
    let fallback_mode = if fallback_roll < 60 {
        FallbackMode::Empty
    } else if fallback_roll < 85 {
        FallbackMode::Partial
    } else {
        FallbackMode::Complete
    };
    let barrel_styles = [
        BarrelStyle::DirectImport,
        BarrelStyle::NamedReExport,
        BarrelStyle::StarReExport,
        BarrelStyle::NamespaceReExport,
    ];
    let barrel_style = *rng
        .choose(&barrel_styles)
        .unwrap_or(&BarrelStyle::NamedReExport);
    WorkspaceShape {
        seed,
        fallback_mode,
        barrel_style,
        use_tsconfig_aliases: rng.chance(1, 2),
        use_file_narrowing: rng.chance(3, 4),
        declare_fs_impact_paths: rng.chance(1, 3),
        use_setup_file: rng.chance(1, 2),
        commit_before_plan: rng.chance(1, 2),
        use_plan_file: rng.chance(1, 2),
        use_shared_cache: rng.chance(3, 4),
    }
}

pub fn generate_workspace(
    root: &Path,
    runner_script: &Path,
    node_bin: &Path,
    shape: &WorkspaceShape,
    rng: &mut SeededRng,
) -> Result<GeneratedWorkspace, String> {
    write_root_files(root, shape)?;
    write_core_and_billing(root, shape)?;
    write_settings(root)?;
    write_ui_and_consumers(root, shape)?;
    write_manifest(root, runner_script, node_bin, shape, rng)?;

    let setup_opt = shape.use_setup_file.then(|| "ui/setup.ts".to_owned());
    let ui_files = vec![
        "ui/tax.test.ts".to_owned(),
        "ui/format.test.ts".to_owned(),
        "ui/json-import.test.ts".to_owned(),
        "ui/disk-read.test.ts".to_owned(),
        "ui/dir-scan.test.ts".to_owned(),
        "ui/dynamic-consumer.test.ts".to_owned(),
    ];
    let mut oracle_tests = Vec::new();
    for file in &ui_files {
        oracle_tests.push(OracleTestSpec {
            file: file.clone(),
            setup_file: setup_opt.clone(),
        });
    }
    oracle_tests.push(OracleTestSpec {
        file: "impact-consumer/flag.test.ts".to_owned(),
        setup_file: None,
    });
    oracle_tests.push(OracleTestSpec {
        file: "unrelated/control.test.ts".to_owned(),
        setup_file: None,
    });

    let mut task_tests = BTreeMap::new();
    task_tests.insert("ui:test".to_owned(), ui_files);
    task_tests.insert(
        "impact-consumer:test".to_owned(),
        vec!["impact-consumer/flag.test.ts".to_owned()],
    );
    task_tests.insert(
        "unrelated:test".to_owned(),
        vec!["unrelated/control.test.ts".to_owned()],
    );

    Ok(GeneratedWorkspace {
        shape: shape.clone(),
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

fn write_root_files(root: &Path, shape: &WorkspaceShape) -> Result<(), String> {
    write_file(
        root,
        "package.json",
        "{\n  \"name\": \"dst-workspace\",\n  \"type\": \"module\"\n}\n",
    )?;
    let paths = if shape.use_tsconfig_aliases {
        json!({
            "@pkg/core": ["core/math.ts"],
            "@pkg/billing": ["billing/tax.ts"],
            "@pkg/dynamic": ["billing/dynamic.ts"]
        })
    } else {
        json!({
            "@pkg/core": ["core/math.ts"]
        })
    };
    let tsconfig_base = json!({
        "compilerOptions": {
            "baseUrl": ".",
            "paths": paths
        }
    });
    write_file(
        root,
        "tsconfig.base.json",
        &format!(
            "{}\n",
            serde_json::to_string_pretty(&tsconfig_base).map_err(|e| e.to_string())?
        ),
    )?;
    write_file(
        root,
        "tsconfig.json",
        "{\n  \"extends\": \"./tsconfig.base.json\"\n}\n",
    )
}

fn write_core_and_billing(root: &Path, shape: &WorkspaceShape) -> Result<(), String> {
    write_file(
        root,
        "core/math.ts",
        r#"// core math module
const baseScale = (): number => 2;
export type TaxAmount = number;
export const pureValue = (n: number): number => n * baseScale();
export const unusedCore = 100;
"#,
    )?;
    write_file(
        root,
        "core/alt.ts",
        r#"export type TaxAmount = number;
export const pureValue = (n: number): number => n * 99;
export const unusedCore = 100;
"#,
    )?;
    write_file(
        root,
        "billing/side-effect.ts",
        r#"(globalThis as Record<string, unknown>).__DST_SIDE_EFFECT__ = true;
export const sideEffectInit = 1;
"#,
    )?;
    let core_spec = if shape.use_tsconfig_aliases {
        "@pkg/core"
    } else {
        "../core/math.ts"
    };
    let billing_tax = format!(
        r#"// billing tax module
import {{ pureValue }} from "{core_spec}";
import type {{ TaxAmount }} from "{core_spec}";

const shared = {{ assign: 2, call: 2, staticBlock: 2, topStmt: 2 }};
function setRate(n: number): number {{
  shared.call = n;
  return n;
}}
const formatPrefix = (): string => "$";

export const assignMarker = (shared.assign = 2);
export const callMarker = setRate(2);
export class TaxBoot {{
  static {{
    shared.staticBlock = 2;
  }}
}}
// top-stmt-slot

export const computeTax = (n: TaxAmount): TaxAmount => {{
  if ((globalThis as Record<string, unknown>).__DST_SIDE_EFFECT__) {{
    return -1;
  }}
  return pureValue(n) + shared.assign + shared.call + shared.staticBlock + shared.topStmt;
}};
export const formatTax = (n: TaxAmount): string => `${{formatPrefix()}}${{n}}`;
export const unusedBilling = 42;
"#
    );
    write_file(root, "billing/tax.ts", &billing_tax)?;
    write_file(
        root,
        "billing/pure.ts",
        r#"const pureHelper = (): number => 10;
export const pureRead = (): number => pureHelper();
export const unusedPureExport = 7;
"#,
    )?;
    write_file(
        root,
        "billing/dynamic-target.ts",
        "export const dynamicRate = 2;\n",
    )?;
    write_file(
        root,
        "billing/dynamic.ts",
        r#"import { dynamicRate } from "./dynamic-target.ts";
export const getDynamicRate = async (): Promise<number> => dynamicRate;
"#,
    )
}

fn write_settings(root: &Path) -> Result<(), String> {
    write_file(root, "settings/limit.json", "{\"limit\": 5}\n")?;
    write_file(root, "settings/disk-limit.json", "{\"limit\": 5}\n")?;
    write_file(root, "settings/impact-flag.json", "{\"flag\": \"ok\"}\n")?;
    write_file(root, "settings/rules/rule-a.txt", "safe-rule\n")
}

fn write_ui_and_consumers(root: &Path, shape: &WorkspaceShape) -> Result<(), String> {
    write_ui_barrel_and_unit_tests(root, shape)?;
    write_ui_asset_and_consumer_tests(root, shape)
}

fn write_ui_barrel_and_unit_tests(root: &Path, shape: &WorkspaceShape) -> Result<(), String> {
    let billing_spec = if shape.use_tsconfig_aliases {
        "@pkg/billing"
    } else {
        "../billing/tax.ts"
    };
    let barrel_source = match shape.barrel_style {
        BarrelStyle::DirectImport | BarrelStyle::NamedReExport => {
            format!("export {{ computeTax, formatTax, unusedBilling }} from \"{billing_spec}\";\n")
        }
        BarrelStyle::StarReExport => format!("export * from \"{billing_spec}\";\n"),
        BarrelStyle::NamespaceReExport => {
            format!("export * as billingNs from \"{billing_spec}\";\n")
        }
    };
    write_file(root, "ui/barrel.ts", &barrel_source)?;

    write_file(
        root,
        "ui/setup-helper.ts",
        "export const setupTag = (): string => \"ok\";\n",
    )?;
    write_file(
        root,
        "ui/setup.ts",
        "import { setupTag } from \"./setup-helper.ts\";\n(globalThis as Record<string, unknown>).__DST_SETUP_TAG__ = setupTag();\n",
    )?;

    let setup_check = if shape.use_setup_file {
        "if ((globalThis as Record<string, unknown>).__DST_SETUP_TAG__ !== \"ok\") throw new Error(\"bad setup tag\");\n"
    } else {
        ""
    };
    let tax_test = match shape.barrel_style {
        BarrelStyle::DirectImport => format!(
            "import {{ computeTax }} from \"{billing_spec}\";\n{setup_check}if (computeTax(3) !== 14) throw new Error(`tax=${{computeTax(3)}}`);\n"
        ),
        BarrelStyle::NamedReExport | BarrelStyle::StarReExport => format!(
            "import {{ computeTax }} from \"./barrel.ts\";\n{setup_check}if (computeTax(3) !== 14) throw new Error(`tax=${{computeTax(3)}}`);\n"
        ),
        BarrelStyle::NamespaceReExport => format!(
            "import {{ billingNs }} from \"./barrel.ts\";\n{setup_check}if (billingNs.computeTax(3) !== 14) throw new Error(`tax=${{billingNs.computeTax(3)}}`);\n"
        ),
    };
    write_file(root, "ui/tax.test.ts", &tax_test)?;

    let core_spec = if shape.use_tsconfig_aliases {
        "@pkg/core"
    } else {
        "../core/math.ts"
    };
    let format_test = match shape.barrel_style {
        BarrelStyle::NamespaceReExport => format!(
            "import type {{ TaxAmount }} from \"{core_spec}\";\nimport {{ billingNs }} from \"./barrel.ts\";\nconst sample: TaxAmount = 3;\nif (billingNs.formatTax(sample) !== \"$3\") throw new Error(\"bad format\");\n"
        ),
        _ => format!(
            "import type {{ TaxAmount }} from \"{core_spec}\";\nimport {{ formatTax }} from \"./barrel.ts\";\nconst sample: TaxAmount = 3;\nif (formatTax(sample) !== \"$3\") throw new Error(\"bad format\");\n"
        ),
    };
    write_file(root, "ui/format.test.ts", &format_test)
}

fn write_ui_asset_and_consumer_tests(root: &Path, shape: &WorkspaceShape) -> Result<(), String> {
    let dynamic_spec = if shape.use_tsconfig_aliases {
        "@pkg/dynamic"
    } else {
        "../billing/dynamic.ts"
    };
    write_file(
        root,
        "ui/json-import.test.ts",
        r#"import cfg from "../settings/limit.json" with { type: "json" };
if (cfg.limit !== 5) throw new Error(`json limit=${cfg.limit}`);
"#,
    )?;
    write_file(
        root,
        "ui/disk-read.test.ts",
        r#"import { readFileSync } from "node:fs";
const parsed = JSON.parse(readFileSync(new URL("../settings/disk-limit.json", import.meta.url), "utf8"));
if (parsed.limit !== 5) throw new Error(`disk limit=${parsed.limit}`);
"#,
    )?;
    write_file(
        root,
        "ui/dir-scan.test.ts",
        r#"import { readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const WORKSPACE_ROOT = resolve(import.meta.dirname, "..");
const RULE_DIRS = [join(WORKSPACE_ROOT, "settings/rules")];

const scratch = join(tmpdir(), `dst-scratch-${process.pid}-${Math.random().toString(16).slice(2)}.txt`);
writeFileSync(scratch, "ok");
readFileSync(scratch, "utf8");
rmSync(scratch, { force: true });

for (const dir of RULE_DIRS) {
  for (const name of readdirSync(dir)) {
    const text = readFileSync(join(dir, name), "utf8");
    if (text.includes("FORBIDDEN")) {
      throw new Error(`forbidden rule in ${name}`);
    }
  }
}
"#,
    )?;
    write_file(
        root,
        "ui/dynamic-consumer.test.ts",
        &format!(
            "import {{ getDynamicRate }} from \"{dynamic_spec}\";\nconst rate = await getDynamicRate();\nif (rate !== 2) throw new Error(`dynamic=${{rate}}`);\n"
        ),
    )?;
    write_file(
        root,
        "impact-consumer/flag.test.ts",
        r#"import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const parsed = JSON.parse(readFileSync(join(root, "settings/impact-flag.json"), "utf8"));
if (parsed.flag !== "ok") throw new Error(`flag=${parsed.flag}`);
"#,
    )?;
    write_file(
        root,
        "unrelated/control.test.ts",
        "if (1 + 1 !== 2) throw new Error(\"math broken\");\n",
    )
}
