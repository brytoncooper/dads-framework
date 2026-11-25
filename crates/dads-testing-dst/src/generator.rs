//! Deterministic generator of executable multi-project TypeScript workspaces for 93-family DST.
//!
//! Splits generation into a shape-independent static skeleton (`write_static_skeleton`) and a
//! compact 7-file shape overlay (`write_shape_overlay`) so `template_cache.rs` can clone the
//! skeleton once via APFS CoW and patch only shape-dependent files per template key.

use crate::generator_advanced::{AdvancedTests, write_advanced_workspace};
use crate::generator_lang_edge::write_lang_edge_workspace;
use crate::generator_lifecycle::{LifecycleTests, write_lifecycle_workspace};
use crate::generator_manifest::{
    ManifestInputs, write_manifest, write_shape_tsconfig_base, write_static_root_config_files,
};
use crate::generator_section_a::{SectionATests, write_section_a_workspace};
use crate::generator_subsystems::{SubsystemTests, write_subsystems_workspace};
use crate::model::{BarrelStyle, FallbackMode, WorkspaceShape};
use crate::node_oracle::OracleTestSpec;
use crate::rng::SeededRng;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct GeneratedWorkspace {
    pub shape: WorkspaceShape,
    pub oracle_tests: Vec<OracleTestSpec>,
    pub task_tests: BTreeMap<String, Vec<String>>,
    pub typecheck_tasks: BTreeMap<String, String>,
}

pub struct StaticSkeletonMeta {
    pub adv: AdvancedTests,
    pub sec_a: SectionATests,
    pub subsystems: SubsystemTests,
    pub lang_edge_adv_files: Vec<String>,
    pub lifecycle: LifecycleTests,
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
    let impact_pattern_idx = u8::try_from(rng.range_usize(3)).unwrap_or(0);
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
        impact_pattern_idx,
    }
}

/// Writes all shape-independent source, config, asset, SQL, lockfile, and test files.
pub fn write_static_skeleton(root: &Path) -> Result<StaticSkeletonMeta, String> {
    write_static_root_config_files(root)?;
    write_static_core_and_settings(root)?;
    write_static_ui_assets_and_consumers(root)?;
    let adv = write_advanced_workspace(root, &pick_workspace_shape(0, &mut SeededRng::new(0)))?;
    let sec_a = write_section_a_workspace(root)?;
    let subsystems = write_subsystems_workspace(root)?;
    let lang_edge_adv_files = write_lang_edge_workspace(root)?;
    let lifecycle = write_lifecycle_workspace(root)?;
    Ok(StaticSkeletonMeta {
        adv,
        sec_a,
        subsystems,
        lang_edge_adv_files,
        lifecycle,
    })
}

/// Writes only the 7 shape-dependent files (`tsconfig.base.json`, `dads.testing.json`,
/// `billing/tax.ts`, `ui/barrel.ts`, `ui/tax.test.ts`, `ui/format.test.ts`,
/// `ui/dynamic-consumer.test.ts`).
pub fn write_shape_overlay(inputs: &ManifestInputs<'_>) -> Result<(), String> {
    write_shape_tsconfig_base(inputs.root, inputs.shape)?;
    write_shape_billing_and_ui(inputs.root, inputs.shape)?;
    write_manifest(inputs)
}

/// Builds the complete test & typecheck inventory for `shape` from the skeleton metadata.
pub fn build_generated_metadata(
    shape: &WorkspaceShape,
    meta: &StaticSkeletonMeta,
) -> GeneratedWorkspace {
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
            env: BTreeMap::new(),
        });
    }
    oracle_tests.push(plain_spec("impact-consumer/flag.test.ts"));
    oracle_tests.push(plain_spec("unrelated/control.test.ts"));
    oracle_tests.extend(meta.adv.oracle_tests.iter().cloned());
    for file in meta
        .sec_a
        .adv_test_files
        .iter()
        .chain(&meta.subsystems.adv_test_files)
        .chain(&meta.lang_edge_adv_files)
        .chain(&meta.lifecycle.adv_test_files)
    {
        oracle_tests.push(plain_spec(file));
    }
    oracle_tests.extend(meta.sec_a.extra_oracle_tests.iter().cloned());
    oracle_tests.extend(meta.subsystems.extra_oracle_tests.iter().cloned());
    oracle_tests.extend(meta.lifecycle.extra_oracle_tests.iter().cloned());

    let mut task_tests = BTreeMap::new();
    task_tests.insert("ui:test".to_owned(), ui_files);
    task_tests.insert(
        "impact-consumer:test".to_owned(),
        vec![
            "impact-consumer/flag.test.ts".to_owned(),
            "impact-consumer/ignored-glob.test.ts".to_owned(),
        ],
    );
    task_tests.insert(
        "unrelated:test".to_owned(),
        vec!["unrelated/control.test.ts".to_owned()],
    );
    for (task_id, files) in &meta.adv.task_tests {
        task_tests.insert(task_id.clone(), files.clone());
    }
    if let Some(adv_files) = task_tests.get_mut("adv:test") {
        adv_files.extend(meta.sec_a.adv_test_files.iter().cloned());
        adv_files.extend(meta.subsystems.adv_test_files.iter().cloned());
        adv_files.extend(meta.lang_edge_adv_files.iter().cloned());
        adv_files.extend(meta.lifecycle.adv_test_files.iter().cloned());
    }
    for (task_id, files) in meta
        .sec_a
        .extra_task_tests
        .iter()
        .chain(&meta.subsystems.extra_task_tests)
        .chain(&meta.lifecycle.extra_task_tests)
    {
        task_tests.insert(task_id.clone(), files.clone());
    }

    let mut typecheck_tasks = BTreeMap::new();
    typecheck_tasks.insert(
        "typecheck-app:typecheck".to_owned(),
        "typecheck-app/tsconfig.json".to_owned(),
    );

    GeneratedWorkspace {
        shape: shape.clone(),
        oracle_tests,
        task_tests,
        typecheck_tasks,
    }
}

fn plain_spec(file: &str) -> OracleTestSpec {
    OracleTestSpec {
        file: file.to_owned(),
        setup_file: None,
        env: BTreeMap::new(),
    }
}

fn write_file(root: &Path, rel: &str, content: &str) -> Result<(), String> {
    let full = root.join(rel);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create dir {}: {error}", parent.display()))?;
    }
    fs::write(&full, content).map_err(|error| format!("write {rel}: {error}"))
}

fn write_static_core_and_settings(root: &Path) -> Result<(), String> {
    let files = [
        (
            "core/setup-const.ts",
            "export const CORE_SETUP_TAG = \"ok\";\n",
        ),
        (
            "core/math.ts",
            "// core math module\nconst baseScale = (): number => 2;\nexport type TaxAmount = number;\nexport const pureValue = (n: number): number => n * baseScale();\nexport const unusedCore = 100;\n",
        ),
        (
            "core/alt.ts",
            "export type TaxAmount = number;\nexport const pureValue = (n: number): number => n * 99;\nexport const unusedCore = 100;\n",
        ),
        (
            "billing/side-effect.ts",
            "(globalThis as Record<string, unknown>).__DST_SIDE_EFFECT__ = true;\nexport const sideEffectInit = 1;\n",
        ),
        (
            "billing/pure.ts",
            "const pureHelper = (): number => 10;\nexport const pureRead = (): number => pureHelper();\nexport const unusedPureExport = 7;\n",
        ),
        (
            "billing/dynamic-target.ts",
            "export const dynamicRate = 2;\n",
        ),
        (
            "billing/dynamic.ts",
            "import { dynamicRate } from \"./dynamic-target.ts\";\nexport const getDynamicRate = async (): Promise<number> => dynamicRate;\n",
        ),
        ("settings/limit.json", "{\"limit\": 5}\n"),
        ("settings/disk-limit.json", "{\"limit\": 5}\n"),
        ("settings/helper-disk.json", "{\"limit\": 5}\n"),
        ("settings/async-limit.json", "{\"limit\": 5}\n"),
        ("settings/sentinel.txt", "present\n"),
        ("settings/impact-flag.json", "{\"flag\": \"ok\"}\n"),
        ("settings/impact-extra.json", "{\"extra\": \"ok\"}\n"),
        ("settings/rules/rule-a.txt", "safe-rule\n"),
        ("settings/rules/rule-b.txt", "safe-rule-b\n"),
        ("settings/nested-rules/sub/deep.txt", "safe-deep\n"),
    ];
    for (rel, content) in files {
        write_file(root, rel, content)?;
    }
    Ok(())
}

fn write_static_ui_assets_and_consumers(root: &Path) -> Result<(), String> {
    let files = [
        (
            "ui/setup-helper.ts",
            "import { CORE_SETUP_TAG } from \"../core/setup-const.ts\";\nexport const setupTag = (): string => CORE_SETUP_TAG;\n",
        ),
        (
            "ui/setup.ts",
            "import { setupTag } from \"./setup-helper.ts\";\n(globalThis as Record<string, unknown>).__DST_SETUP_TAG__ = setupTag();\n",
        ),
        (
            "ui/json-import.test.ts",
            "import cfg from \"../settings/limit.json\" with { type: \"json\" };\nif (cfg.limit !== 5) throw new Error(`json limit=${cfg.limit}`);\n",
        ),
        (
            "ui/disk-read.test.ts",
            "import { readFileSync } from \"node:fs\";\nconst parsed = JSON.parse(readFileSync(new URL(\"../settings/disk-limit.json\", import.meta.url), \"utf8\"));\nif (parsed.limit !== 5) throw new Error(`disk limit=${parsed.limit}`);\n",
        ),
        (
            "ui/dir-scan.test.ts",
            concat!(
                "import { readdirSync, readFileSync, writeFileSync, rmSync } from \"node:fs\";\n",
                "import { tmpdir } from \"node:os\";\n",
                "import { join, resolve } from \"node:path\";\n",
                "const WORKSPACE_ROOT = resolve(import.meta.dirname, \"..\");\n",
                "const RULE_DIRS = [join(WORKSPACE_ROOT, \"settings/rules\")];\n",
                "const scratch = join(tmpdir(), `dst-scratch-${process.pid}-${Math.random().toString(16).slice(2)}.txt`);\n",
                "writeFileSync(scratch, \"ok\"); readFileSync(scratch, \"utf8\"); rmSync(scratch, { force: true });\n",
                "for (const dir of RULE_DIRS) {\n",
                "  const names = readdirSync(dir);\n",
                "  if (names.length < 2) throw new Error(`missing rule files: ${names.length}`);\n",
                "  for (const name of names) {\n",
                "    if (readFileSync(join(dir, name), \"utf8\").includes(\"FORBIDDEN\")) throw new Error(`forbidden rule in ${name}`);\n",
                "  }\n",
                "}\n",
            ),
        ),
        (
            "impact-consumer/flag.test.ts",
            concat!(
                "import { existsSync, readFileSync } from \"node:fs\";\n",
                "import { join, resolve } from \"node:path\";\n",
                "const root = resolve(import.meta.dirname, \"..\");\n",
                "const parsed = JSON.parse(readFileSync(join(root, \"settings/impact-flag.json\"), \"utf8\"));\n",
                "if (parsed.flag !== \"ok\") throw new Error(`flag=${parsed.flag}`);\n",
                "if (!existsSync(join(root, \"settings/impact-extra.json\"))) throw new Error(\"impact-extra missing\");\n",
            ),
        ),
        (
            "unrelated/control.test.ts",
            "if (1 + 1 !== 2) throw new Error(\"math broken\");\n",
        ),
    ];
    for (rel, content) in files {
        write_file(root, rel, content)?;
    }
    Ok(())
}

fn write_shape_billing_and_ui(root: &Path, shape: &WorkspaceShape) -> Result<(), String> {
    let core_spec = if shape.use_tsconfig_aliases {
        "@pkg/core"
    } else {
        "../core/math.ts"
    };
    let billing_spec = if shape.use_tsconfig_aliases {
        "@pkg/billing"
    } else {
        "../billing/tax.ts"
    };
    let dynamic_spec = if shape.use_tsconfig_aliases {
        "@pkg/dynamic"
    } else {
        "../billing/dynamic.ts"
    };
    let billing_tax = format!(
        "// billing tax module\nimport {{ pureValue }} from \"{core_spec}\";\nimport type {{ TaxAmount }} from \"{core_spec}\";\n\nconst shared = {{ assign: 2, call: 2, staticBlock: 2, topStmt: 2 }};\nfunction setRate(n: number): number {{\n  shared.call = n;\n  return n;\n}}\nconst formatPrefix = (): string => \"$\";\n\nexport const assignMarker = (shared.assign = 2);\nexport const callMarker = setRate(2);\nexport class TaxBoot {{\n  static {{\n    shared.staticBlock = 2;\n  }}\n}}\n// top-stmt-slot\n\nexport const computeTax = (n: TaxAmount): TaxAmount => {{\n  if ((globalThis as Record<string, unknown>).__DST_SIDE_EFFECT__) {{\n    return -1;\n  }}\n  return pureValue(n) + shared.assign + shared.call + shared.staticBlock + shared.topStmt;\n}};\nexport const formatTax = (n: TaxAmount): string => `${{formatPrefix()}}${{n}}`;\nexport const unusedBilling = 42;\n"
    );
    write_file(root, "billing/tax.ts", &billing_tax)?;
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
    let format_test = match shape.barrel_style {
        BarrelStyle::NamespaceReExport => format!(
            "import type {{ TaxAmount }} from \"{core_spec}\";\nimport {{ billingNs }} from \"./barrel.ts\";\nconst sample: TaxAmount = 3;\nif (billingNs.formatTax(sample) !== \"$3\") throw new Error(\"bad format\");\n"
        ),
        _ => format!(
            "import type {{ TaxAmount }} from \"{core_spec}\";\nimport {{ formatTax }} from \"./barrel.ts\";\nconst sample: TaxAmount = 3;\nif (formatTax(sample) !== \"$3\") throw new Error(\"bad format\");\n"
        ),
    };
    write_file(root, "ui/format.test.ts", &format_test)?;
    write_file(
        root,
        "ui/dynamic-consumer.test.ts",
        &format!(
            "import {{ getDynamicRate }} from \"{dynamic_spec}\";\nconst rate = await getDynamicRate();\nif (rate !== 2) throw new Error(`dynamic=${{rate}}`);\n"
        ),
    )
}
