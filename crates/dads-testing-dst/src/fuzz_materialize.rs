//! Materializes a `ChaosWorkspaceSpec` into a temporary git workspace with `dads.testing.json`,
//! `tsconfig.base.json`, per-project `tsconfig.json`, runtime helpers, fixtures, and `.test.ts`
//! suites whose baseline checksums are recorded via `NodeOracleWorker`.

use crate::fuzz_graph::{ChaosWorkspaceSpec, relative_import_path};
use crate::fuzz_render::{render_extra_test, render_module, render_suite_test};
use crate::mutations::{git_init_and_commit, replace_once};
use crate::node_oracle::{NodeOracleWorker, OracleTestSpec};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

const CHAOS_RT_TS: &str = r#"export const mkPure = (n: number): number => n + 1;
export const z = { num: (n: number): number => n * 2 };
export function bumpChaos(id: number, val: number): number {
  const g = globalThis as Record<string, unknown>;
  const prev = g.__CHAOS_REG__;
  const map = prev instanceof Map ? (prev as Map<number, number>) : new Map<number, number>();
  map.set(id, val);
  g.__CHAOS_REG__ = map;
  return val;
}
export function readChaosReg(): number {
  const g = globalThis as Record<string, unknown>;
  const prev = g.__CHAOS_REG__;
  if (!(prev instanceof Map)) return 0;
  const entries = Array.from((prev as Map<number, number>).entries()).sort((a, b) => a[0] - b[0]);
  let h = 17;
  for (const [k, v] of entries) {
    h = (h * 31 + k * 97 + v) | 0;
  }
  return h;
}
"#;

const CHAOS_NODE_SHIM_DTS: &str = r#"declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
}
declare class URL {
  constructor(input: string, base?: string | URL);
}
interface ImportMeta {
  url: string;
}
declare var process: {
  env: Record<string, string | undefined>;
};
"#;

pub struct ChaosMaterializeTools<'a> {
    pub node_bin: &'a Path,
    pub runner_script: &'a Path,
    pub typecheck_script: &'a Path,
    pub typescript_js: &'a Path,
}

#[derive(Debug, Clone)]
pub struct MaterializedChaosWorkspace {
    pub baseline_sha: String,
    pub task_tests: BTreeMap<String, Vec<String>>,
    pub oracle_tests: Vec<OracleTestSpec>,
    pub typecheck_tasks: BTreeMap<String, String>,
}

pub fn materialize_chaos_workspace(
    root: &Path,
    spec: &ChaosWorkspaceSpec,
    tools: &ChaosMaterializeTools<'_>,
    oracle: &mut NodeOracleWorker,
) -> Result<MaterializedChaosWorkspace, String> {
    write_root_configs(root, spec)?;
    write_file(root, "chaos-rt/rt.ts", CHAOS_RT_TS)?;
    write_file(root, "chaos-rt/node-shim.d.ts", CHAOS_NODE_SHIM_DTS)?;
    for fx in &spec.fixtures {
        write_file(root, &fx.rel_path, &format!("{{\"value\":{}}}\n", fx.value))?;
    }
    for module in &spec.modules {
        write_file(root, &module.rel_path, &render_module(spec, module))?;
    }

    let mut task_tests = BTreeMap::new();
    let mut oracle_tests = Vec::new();
    let mut typecheck_tasks = BTreeMap::new();

    for (p_idx, proj) in spec.projects.iter().enumerate() {
        let proj_mods: Vec<usize> = spec
            .modules
            .iter()
            .filter(|m| m.project_idx == p_idx)
            .map(|m| m.id)
            .collect();
        let suite_rel = format!("{}/a-suite.test.ts", proj.root);
        let suite_src = render_suite_test(spec, proj, p_idx, &suite_rel, &proj_mods);
        write_file(root, &suite_rel, &suite_src)?;

        let mut env = BTreeMap::new();
        env.insert("CHAOS_ENV".to_owned(), proj.env_tag.clone());
        let mut files = vec![suite_rel.clone()];
        oracle_tests.push(OracleTestSpec {
            file: suite_rel,
            setup_file: None,
            env,
        });

        if proj_mods.len() >= 2
            && let Some(&last_mod) = proj_mods.last()
        {
            let extra_rel = format!("{}/b-extra.test.ts", proj.root);
            write_file(
                root,
                &extra_rel,
                &render_extra_test(spec, &extra_rel, last_mod),
            )?;
            files.push(extra_rel.clone());
            oracle_tests.push(OracleTestSpec {
                file: extra_rel,
                setup_file: None,
                env: BTreeMap::new(),
            });
        }
        task_tests.insert(format!("{}:test", proj.id), files);

        if proj.has_typecheck {
            let tc_rel = format!("{}/tsconfig.json", proj.root);
            write_project_tsconfig(root, &tc_rel)?;
            typecheck_tasks.insert(format!("{}:typecheck", proj.id), tc_rel);
        }
    }

    write_chaos_manifest(root, spec, tools)?;
    record_and_patch_baseline_checksums(root, &oracle_tests, oracle)?;
    let baseline_sha = git_init_and_commit(root, "chaos baseline")?;

    Ok(MaterializedChaosWorkspace {
        baseline_sha,
        task_tests,
        oracle_tests,
        typecheck_tasks,
    })
}

fn record_and_patch_baseline_checksums(
    root: &Path,
    oracle_tests: &[OracleTestSpec],
    oracle: &mut NodeOracleWorker,
) -> Result<(), String> {
    let record_specs: Vec<OracleTestSpec> = oracle_tests
        .iter()
        .cloned()
        .map(|mut s| {
            s.env
                .insert("CHAOS_RECORD_BASELINE".to_owned(), "1".to_owned());
            s
        })
        .collect();
    let results = oracle.evaluate(root, &record_specs)?;
    for spec in oracle_tests {
        let Some(outcome) = results.get(&spec.file) else {
            return Err(format!("baseline probe missing result for {}", spec.file));
        };
        let Some(err) = outcome.error.as_deref() else {
            return Err(format!("baseline probe missed checksum for {}", spec.file));
        };
        let Some(raw_val) = err.strip_prefix("__CHAOS_BASELINE__:") else {
            return Err(format!("baseline probe error for {}: {err}", spec.file));
        };
        let checksum: i32 = raw_val
            .trim()
            .parse()
            .map_err(|e| format!("parse checksum `{raw_val}` for {}: {e}", spec.file))?;
        replace_once(
            root,
            &spec.file,
            "const EXPECTED = 0; // @expected",
            &format!("const EXPECTED = {checksum}; // @expected"),
        )?;
    }
    Ok(())
}

fn write_root_configs(root: &Path, spec: &ChaosWorkspaceSpec) -> Result<(), String> {
    write_file(root, ".gitignore", "node_modules/\n")?;
    write_file(
        root,
        "package.json",
        "{\n  \"name\": \"chaos-workspace\",\n  \"type\": \"module\"\n}\n",
    )?;
    let mut paths = Map::new();
    for proj in &spec.projects {
        paths.insert(
            format!("@{}/*", proj.id),
            json!([format!("{}/*", proj.root)]),
        );
    }
    let tsconfig_base = json!({
        "compilerOptions": {
            "target": "ES2022",
            "module": "ESNext",
            "moduleResolution": "Bundler",
            "lib": ["es2022"],
            "types": [],
            "strict": true,
            "noEmit": true,
            "skipLibCheck": true,
            "ignoreDeprecations": "6.0",
            "allowImportingTsExtensions": true,
            "baseUrl": ".",
            "paths": Value::Object(paths)
        }
    });
    let base_text = serde_json::to_string_pretty(&tsconfig_base).map_err(|e| e.to_string())?;
    write_file(root, "tsconfig.base.json", &format!("{base_text}\n"))?;
    write_file(
        root,
        "tsconfig.json",
        "{\n  \"extends\": \"./tsconfig.base.json\"\n}\n",
    )
}

fn write_project_tsconfig(root: &Path, tsconfig_rel: &str) -> Result<(), String> {
    let extends_base = relative_import_path(tsconfig_rel, "tsconfig.base.json");
    let shim_path = relative_import_path(tsconfig_rel, "chaos-rt/node-shim.d.ts");
    let doc = json!({
        "extends": extends_base,
        "include": ["./**/*.ts", shim_path]
    });
    let text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    write_file(root, tsconfig_rel, &format!("{text}\n"))
}

fn write_chaos_manifest(
    root: &Path,
    spec: &ChaosWorkspaceSpec,
    tools: &ChaosMaterializeTools<'_>,
) -> Result<(), String> {
    let mut projects = vec![
        json!({ "id": "chaos-rt", "root": "chaos-rt", "fallbackDependencies": [] }),
        json!({ "id": "fixtures", "root": "fixtures", "fallbackDependencies": [] }),
    ];
    let mut tasks = Vec::new();
    let mut fallback_task_ids = Vec::new();
    let node_str = tools.node_bin.to_string_lossy().into_owned();
    let runner_str = tools.runner_script.to_string_lossy().into_owned();
    let tc_script_str = tools.typecheck_script.to_string_lossy().into_owned();
    let ts_str = tools.typescript_js.to_string_lossy().into_owned();

    for proj in &spec.projects {
        projects.push(json!({
            "id": proj.id,
            "root": proj.root,
            "fallbackDependencies": proj.fallback_deps
        }));
        let test_id = format!("{}:test", proj.id);
        fallback_task_ids.push(test_id.clone());
        let mut exec = json!({
            "executable": node_str,
            "args": ["--no-warnings", "--experimental-transform-types", runner_str, "--ts", ts_str, proj.root],
            "env": { "CHAOS_ENV": proj.env_tag }
        });
        if spec.use_file_narrowing
            && let Some(obj) = exec.as_object_mut()
        {
            obj.insert(
                "fileNarrowing".to_owned(),
                json!({ "suffixes": [".test.ts"], "setupFiles": [] }),
            );
        }
        tasks.push(json!({
            "id": test_id,
            "project": proj.id,
            "kind": "test",
            "cache": true,
            "execution": exec,
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": [] }
        }));
        if proj.has_typecheck {
            let tc_id = format!("{}:typecheck", proj.id);
            fallback_task_ids.push(tc_id.clone());
            tasks.push(json!({
                "id": tc_id,
                "project": proj.id,
                "kind": "typecheck",
                "cache": true,
                "execution": {
                    "executable": node_str,
                    "args": ["--no-warnings", tc_script_str, ts_str, format!("{}/tsconfig.json", proj.root)]
                },
                "dependsOn": [],
                "impact": { "mode": "reachability", "paths": [] }
            }));
        }
    }

    let manifest = json!({
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "pureFactories": spec.pure_factories,
            "fullFallback": { "taskIds": fallback_task_ids }
        },
        "projects": projects,
        "tasks": tasks
    });
    let text = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    write_file(root, "dads.testing.json", &format!("{text}\n"))
}

fn write_file(root: &Path, rel: &str, content: &str) -> Result<(), String> {
    let full = root.join(rel);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    fs::write(&full, content).map_err(|e| format!("write {rel}: {e}"))
}
