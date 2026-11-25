#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use dads_testing_core::{NativeRequest, Operation, PlanResult, execute_request_with_graph};
use dads_testing_javascript::{analyze_request, analyze_workspace, analyze_workspace_graph};
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct TestRepo {
    root: PathBuf,
}

impl TestRepo {
    fn new(label: &str) -> Self {
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "dads-js-asset-fs-{label}-{}-{seq}",
            std::process::id()
        ));
        let _ = remove_dir_all(&root);
        create_dir_all(&root).expect("create temp repo");
        Self { root }
    }

    fn write(&self, rel: &str, content: &str) {
        let full = self.root.join(rel);
        if let Some(parent) = full.parent() {
            create_dir_all(parent).expect("create parent dirs");
        }
        write(&full, content).expect("write file");
    }

    fn git(&self, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(&self.root)
            .output()
            .expect("run git");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init_commit(&self) {
        self.git(&["init", "-q"]);
        self.git(&["config", "user.email", "test@dads.invalid"]);
        self.git(&["config", "user.name", "Dads Test"]);
        self.git(&["add", "."]);
        self.git(&["commit", "-qm", "baseline"]);
    }

    fn plan(&self) -> PlanResult {
        let req = NativeRequest {
            schema_version: 1,
            operation: Operation::Plan,
            workspace_root: self.root.display().to_string(),
            base: Some("HEAD".to_owned()),
            ..NativeRequest::default()
        };
        let graph = analyze_request(&req).expect("graph evidence must be available");
        let response = execute_request_with_graph(req, Some(graph));
        assert!(response.ok, "plan failed: {:?}", response.error);
        response.result.expect("missing plan result").plan
    }
}

impl Drop for TestRepo {
    fn drop(&mut self) {
        let _ = remove_dir_all(&self.root);
    }
}

fn task_decision<'a>(plan: &'a PlanResult, task_id: &str) -> &'a dads_testing_core::TaskDecision {
    plan.tasks
        .iter()
        .find(|task| task.id == task_id)
        .unwrap_or_else(|| panic!("missing task {task_id} in {plan:?}"))
}

fn three_project_manifest(projects: &[(&str, &str)], test_projects: &[&str]) -> String {
    let project_entries: Vec<String> = projects
        .iter()
        .map(|(id, root)| {
            format!(r#"{{ "id": "{id}", "root": "{root}", "fallbackDependencies": [] }}"#)
        })
        .collect();
    let task_entries: Vec<String> = test_projects
        .iter()
        .map(|id| {
            format!(
                r#"{{
                    "id": "{id}:test",
                    "project": "{id}",
                    "kind": "test",
                    "execution": {{
                        "executable": "node",
                        "args": ["-e", "process.exit(0)"],
                        "fileNarrowing": {{ "suffixes": [".test.ts"] }}
                    }},
                    "dependsOn": [],
                    "impact": {{ "mode": "reachability" }}
                }}"#
            )
        })
        .collect();
    let fallback_ids: Vec<String> = test_projects
        .iter()
        .map(|id| format!(r#""{id}:test""#))
        .collect();
    format!(
        r#"{{
            "schemaVersion": 1,
            "workspace": {{
                "root": ".",
                "fullFallback": {{ "taskIds": [{}] }}
            }},
            "projects": [{}],
            "tasks": [{}]
        }}"#,
        fallback_ids.join(","),
        project_entries.join(","),
        task_entries.join(","),
    )
}

#[test]
fn static_non_js_imports_across_projects_reach_importers_and_skip_unrelated() {
    let repo = TestRepo::new("static-non-js");
    repo.write(
        "dads.testing.json",
        &three_project_manifest(
            &[("settings", "settings"), ("ui", "ui"), ("other", "other")],
            &["ui", "other"],
        ),
    );
    repo.write("settings/limit.json", r#"{ "max": 10 }"#);
    repo.write("settings/theme.css", ".btn { color: blue; }\n");
    repo.write("settings/schema.sql", "CREATE TABLE items (id INT);\n");
    repo.write(
        "ui/src/limit.ts",
        "import limit from '../../settings/limit.json';\nexport const maxLimit = limit.max;\n",
    );
    repo.write(
        "ui/src/limit.test.ts",
        "import { maxLimit } from './limit';\nexport const check = () => maxLimit;\n",
    );
    repo.write(
        "ui/src/styles.test.ts",
        "import '../../settings/theme.css';\nexport const check = () => true;\n",
    );
    repo.write(
        "ui/src/sql.test.ts",
        "import schema from '../../settings/schema.sql?raw';\nexport const check = () => schema;\n",
    );
    repo.write(
        "other/src/unrelated.test.ts",
        "export const check = () => 1;\n",
    );
    repo.init_commit();

    // 1. Mutate settings/limit.json -> reaches ui/src/limit.test.ts through ui/src/limit.ts.
    repo.write("settings/limit.json", r#"{ "max": 25 }"#);
    let plan = repo.plan();
    assert!(
        plan.issues.is_empty(),
        "unexpected issues: {:?}",
        plan.issues
    );
    assert_eq!(task_decision(&plan, "ui:test").decision, "run");
    assert_eq!(
        task_decision(&plan, "ui:test").selected_files,
        vec!["ui/src/limit.test.ts".to_owned()]
    );
    assert_eq!(
        task_decision(&plan, "other:test").decision,
        "skip-proven-unaffected"
    );

    // 2. Revert limit.json, mutate settings/theme.css -> reaches ui/src/styles.test.ts only.
    repo.git(&["checkout", "--", "settings/limit.json"]);
    repo.write("settings/theme.css", ".btn { color: red; }\n");
    let css_plan = repo.plan();
    assert!(
        css_plan.issues.is_empty(),
        "unexpected issues: {:?}",
        css_plan.issues
    );
    assert_eq!(task_decision(&css_plan, "ui:test").decision, "run");
    assert_eq!(
        task_decision(&css_plan, "ui:test").selected_files,
        vec!["ui/src/styles.test.ts".to_owned()]
    );
    assert_eq!(
        task_decision(&css_plan, "other:test").decision,
        "skip-proven-unaffected"
    );

    // 3. Revert theme.css, mutate settings/schema.sql -> reaches ui/src/sql.test.ts (?raw) only.
    repo.git(&["checkout", "--", "settings/theme.css"]);
    repo.write(
        "settings/schema.sql",
        "CREATE TABLE items (id INT, name TEXT);\n",
    );
    let sql_plan = repo.plan();
    assert!(
        sql_plan.issues.is_empty(),
        "unexpected issues: {:?}",
        sql_plan.issues
    );
    assert_eq!(task_decision(&sql_plan, "ui:test").decision, "run");
    assert_eq!(
        task_decision(&sql_plan, "ui:test").selected_files,
        vec!["ui/src/sql.test.ts".to_owned()]
    );
    assert_eq!(
        task_decision(&sql_plan, "other:test").decision,
        "skip-proven-unaffected"
    );
}

#[test]
fn read_file_sync_new_url_and_helpers_reach_tests_with_zero_impact_paths() {
    let repo = TestRepo::new("fs-read-url");
    repo.write(
        "dads.testing.json",
        &three_project_manifest(
            &[("settings", "settings"), ("ui", "ui"), ("other", "other")],
            &["ui", "other"],
        ),
    );
    repo.write("settings/limit.json", r#"{ "max": 10 }"#);
    repo.write("settings/extra.json", r#"{ "enabled": true }"#);
    repo.write(
        "ui/limit.test.ts",
        r#"
import { readFileSync } from "node:fs";
const raw = readFileSync(new URL("../settings/limit.json", import.meta.url), "utf8");
export const value = JSON.parse(raw).max;
"#,
    );
    repo.write(
        "ui/helper-read.test.ts",
        r#"
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadSetting(name: string) {
  return readFile(join(__dirname, "../settings", name), "utf8");
}
export const loaded = () => loadSetting("extra.json");
"#,
    );
    repo.write("other/unrelated.test.ts", "export const ok = true;\n");
    repo.init_commit();

    repo.write("settings/limit.json", r#"{ "max": 99 }"#);
    let plan = repo.plan();
    assert!(
        plan.issues.is_empty(),
        "unexpected issues: {:?}",
        plan.issues
    );
    assert_eq!(task_decision(&plan, "ui:test").decision, "run");
    assert_eq!(
        task_decision(&plan, "ui:test").selected_files,
        vec!["ui/limit.test.ts".to_owned()]
    );
    assert_eq!(
        task_decision(&plan, "other:test").decision,
        "skip-proven-unaffected"
    );

    repo.git(&["checkout", "--", "settings/limit.json"]);
    repo.write("settings/extra.json", r#"{ "enabled": false }"#);
    let extra_plan = repo.plan();
    assert!(
        extra_plan.issues.is_empty(),
        "unexpected issues: {:?}",
        extra_plan.issues
    );
    assert_eq!(task_decision(&extra_plan, "ui:test").decision, "run");
    assert_eq!(
        task_decision(&extra_plan, "ui:test").selected_files,
        vec!["ui/helper-read.test.ts".to_owned()]
    );
    assert_eq!(
        task_decision(&extra_plan, "other:test").decision,
        "skip-proven-unaffected"
    );
}

#[test]
fn readdir_sync_const_array_roots_reaches_test_on_edit_and_new_tsx_file() {
    let repo = TestRepo::new("readdir-const-array");
    repo.write(
        "dads.testing.json",
        &three_project_manifest(
            &[
                ("web", "apps/web"),
                ("ui", "libs/ui"),
                ("other", "libs/other"),
            ],
            &["web", "other"],
        ),
    );
    repo.write(
        "libs/ui/src/button.tsx",
        "export function Button() { return <button className=\"btn\">Go</button>; }\n",
    );
    repo.write(
        "apps/web/src/reduced-motion-source.test.ts",
        r#"
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../..");
const ROOTS = [join(WORKSPACE_ROOT, "libs/ui")] as const;

function collectTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsx(full));
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap((root) => collectTsx(root));
export const scan = () => files.map((file) => readFileSync(file, "utf8"));
"#,
    );
    repo.write("libs/other/src/unrelated.test.ts", "export const ok = 1;\n");
    repo.init_commit();

    // 1. Mutate an existing .tsx file under libs/ui.
    repo.write(
        "libs/ui/src/button.tsx",
        "export function Button() { return <button className=\"animate-pulse\">Go</button>; }\n",
    );
    let edit_plan = repo.plan();
    assert!(
        edit_plan.issues.is_empty(),
        "unexpected issues: {:?}",
        edit_plan.issues
    );
    assert_eq!(task_decision(&edit_plan, "web:test").decision, "run");
    assert_eq!(
        task_decision(&edit_plan, "web:test").selected_files,
        vec!["apps/web/src/reduced-motion-source.test.ts".to_owned()]
    );
    assert_eq!(
        task_decision(&edit_plan, "other:test").decision,
        "skip-proven-unaffected"
    );

    // 2. Revert edit and add a brand-new untracked .tsx file under libs/ui.
    repo.git(&["checkout", "--", "libs/ui/src/button.tsx"]);
    repo.write(
        "libs/ui/src/badge.tsx",
        "export function Badge() { return <span className=\"animate-spin\">New</span>; }\n",
    );
    let add_plan = repo.plan();
    assert!(
        add_plan.issues.is_empty(),
        "unexpected issues: {:?}",
        add_plan.issues
    );
    assert_eq!(task_decision(&add_plan, "web:test").decision, "run");
    assert_eq!(
        task_decision(&add_plan, "web:test").selected_files,
        vec!["apps/web/src/reduced-motion-source.test.ts".to_owned()]
    );
    assert_eq!(
        task_decision(&add_plan, "other:test").decision,
        "skip-proven-unaffected"
    );
}

#[test]
fn import_meta_glob_reaches_module_on_matching_fixture_edit_and_addition() {
    let repo = TestRepo::new("meta-glob");
    repo.write(
        "dads.testing.json",
        &three_project_manifest(&[("app", "app"), ("other", "other")], &["app", "other"]),
    );
    repo.write("app/src/fixtures/alpha.json", r#"{ "ok": true }"#);
    repo.write("app/src/fixtures/notes.txt", "ignored by *.json\n");
    repo.write(
        "app/src/glob.test.ts",
        "export const fixtures = import.meta.glob('./fixtures/*.json', { eager: true });\n",
    );
    repo.write("app/src/unrelated.test.ts", "export const ok = true;\n");
    repo.write("other/src/unrelated.test.ts", "export const ok = true;\n");
    repo.init_commit();

    repo.write("app/src/fixtures/alpha.json", r#"{ "ok": false }"#);
    let edit_plan = repo.plan();
    assert!(
        edit_plan.issues.is_empty(),
        "unexpected issues: {:?}",
        edit_plan.issues
    );
    assert_eq!(task_decision(&edit_plan, "app:test").decision, "run");
    assert_eq!(
        task_decision(&edit_plan, "app:test").selected_files,
        vec!["app/src/glob.test.ts".to_owned()]
    );
    assert_eq!(
        task_decision(&edit_plan, "other:test").decision,
        "skip-proven-unaffected"
    );

    repo.git(&["checkout", "--", "app/src/fixtures/alpha.json"]);
    repo.write("app/src/fixtures/beta.json", r#"{ "added": true }"#);
    let add_plan = repo.plan();
    assert!(
        add_plan.issues.is_empty(),
        "unexpected issues: {:?}",
        add_plan.issues
    );
    assert_eq!(task_decision(&add_plan, "app:test").decision, "run");
    assert_eq!(
        task_decision(&add_plan, "app:test").selected_files,
        vec!["app/src/glob.test.ts".to_owned()]
    );
    assert_eq!(
        task_decision(&add_plan, "other:test").decision,
        "skip-proven-unaffected"
    );
}

#[test]
fn tmpdir_fs_reads_workspace_root_reads_and_node_modules_assets_produce_zero_widening() {
    let repo = TestRepo::new("tmp-and-safety");
    repo.write(
        "node_modules/ext-pkg/package.json",
        r#"{ "name": "ext-pkg", "version": "1.0.0" }"#,
    );
    repo.write(
        "src/tmp.test.ts",
        r#"
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import pkg from "ext-pkg/package.json";

export const fromTmp = readFileSync(join(os.tmpdir(), "x.json"), "utf8");
export const outside = existsSync("/tmp/never-in-workspace.json");
export const rootEntries = readdirSync(process.cwd());
export const pkgName = pkg.name;
"#,
    );
    repo.write("src/other.ts", "export const other = 1;\n");

    let facts = analyze_workspace(&repo.root);
    assert!(
        facts.uncertainties.is_empty(),
        "tmp/root/node_modules reads must emit zero uncertainties: {:?}",
        facts.uncertainties
    );
    let tmp_mod = facts
        .modules
        .iter()
        .find(|m| m.path == "src/tmp.test.ts")
        .expect("tmp.test.ts must be indexed");
    assert!(
        !tmp_mod
            .imports
            .iter()
            .any(|imp| imp.specifier.starts_with("fs:")),
        "tmpdir, /tmp, and workspace-root reads must produce zero fs edges: {:?}",
        tmp_mod.imports
    );
    assert!(
        !tmp_mod.imports.iter().any(|imp| imp
            .resolved_path
            .as_deref()
            .is_some_and(|p| p.contains("node_modules"))),
        "node_modules assets must not resolve into workspace asset edges: {:?}",
        tmp_mod.imports
    );
}

#[test]
fn check_boundaries_emits_zero_false_violations_for_fs_reads_and_skips_asset_nodes() {
    let repo = TestRepo::new("boundaries-fs");
    repo.write(
        "tsconfig.base.json",
        r#"{ "compilerOptions": { "paths": { "@ws/ui": ["libs/ui/src/index.ts"], "@ws/server": ["libs/server/src/index.ts"] } } }"#,
    );
    repo.write(
        "libs/ui/project.json",
        r#"{ "name": "ui", "projectType": "library", "tags": ["env:browser"] }"#,
    );
    repo.write(
        "libs/server/project.json",
        r#"{ "name": "server", "projectType": "library", "tags": ["env:server"] }"#,
    );
    repo.write(
        "dads.testing.json",
        r#"{
            "schemaVersion": 1,
            "workspace": {
                "root": ".",
                "fullFallback": { "taskIds": ["ui:test"] },
                "boundaries": {
                    "checkNestedImports": true,
                    "banTransitiveDependencies": true,
                    "depConstraints": [
                        {
                            "sourceTag": "env:browser",
                            "onlyDependOnLibsWithTags": ["env:browser"],
                            "notDependOnLibsWithTags": ["env:server"]
                        }
                    ]
                }
            },
            "projects": [
                { "id": "ui", "root": "libs/ui", "fallbackDependencies": [] },
                { "id": "server", "root": "libs/server", "fallbackDependencies": [] }
            ],
            "tasks": [
                {
                    "id": "ui:test",
                    "project": "ui",
                    "kind": "test",
                    "execution": { "executable": "node", "args": ["-e", "process.exit(0)"] },
                    "dependsOn": [],
                    "impact": { "mode": "reachability" }
                }
            ]
        }"#,
    );
    repo.write("libs/ui/src/config.json", r#"{ "theme": "dark" }"#);
    repo.write(
        "libs/ui/src/index.ts",
        "import cfg from './config.json';\nexport const theme = cfg.theme;\n",
    );
    repo.write("libs/server/src/index.ts", "export const secret = 42;\n");
    repo.write(
        "libs/ui/src/source-audit.test.ts",
        r#"
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../..");
const ROOTS = [join(WORKSPACE_ROOT, "libs/server")];
export const scan = () => ROOTS.map((r) => readdirSync(r).map((f) => readFileSync(join(r, f), "utf8")));
"#,
    );
    repo.init_commit();

    let graph = analyze_workspace_graph(Path::new(&repo.root), None);
    let req = NativeRequest {
        schema_version: 1,
        operation: Operation::CheckBoundaries,
        workspace_root: repo.root.display().to_string(),
        ..NativeRequest::default()
    };
    let response = execute_request_with_graph(req, Some(graph));
    assert!(response.ok, "check-boundaries failed: {:?}", response.error);
    let boundaries = response
        .result
        .expect("missing result")
        .boundaries
        .expect("missing boundaries");
    assert!(
        boundaries.violations.is_empty(),
        "fs reads and same-project json imports must produce zero boundary violations: {:?}",
        boundaries.violations
    );
    assert_eq!(
        boundaries.checked_files, 3,
        "synthetic asset nodes must not inflate checked_files"
    );
}
