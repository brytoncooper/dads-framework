use dads_testing_core::graph::{ChangedModuleEvidence, DependencyGraph, ModuleNode};
use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, TaskReceiptEntry, TaskReceiptRequest,
    TaskReceiptStore, execute_request, execute_request_with_graph_and_receipts,
};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

struct MemoryReceiptStore {
    entries: Mutex<BTreeMap<String, TaskReceiptEntry>>,
}

impl MemoryReceiptStore {
    fn new() -> Self {
        Self {
            entries: Mutex::new(BTreeMap::new()),
        }
    }

    fn count(&self) -> usize {
        self.entries.lock().map(|g| g.len()).unwrap_or(0)
    }
}

impl TaskReceiptStore for MemoryReceiptStore {
    fn compute_key(&self, request: &TaskReceiptRequest<'_>) -> Option<String> {
        Some(format!(
            "{}|{}|{:?}|{:?}",
            request.task_id, request.executable, request.env, request.selected_files
        ))
    }

    fn lookup(&self, key: &str) -> Option<TaskReceiptEntry> {
        self.entries.lock().ok()?.get(key).cloned()
    }

    fn record_pass(&self, key: &str, entry: &TaskReceiptEntry) {
        if let Ok(mut guard) = self.entries.lock() {
            guard.insert(key.to_owned(), entry.clone());
        }
    }
}

fn git(dir: &Path, args: &[&str]) -> Result<(), Box<dyn Error>> {
    let status = Command::new("git").args(args).current_dir(dir).status()?;
    assert!(status.success(), "git {args:?} failed");
    Ok(())
}

fn commit_all(dir: &Path) -> Result<(), Box<dyn Error>> {
    git(dir, &["add", "."])?;
    git(
        dir,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@e.invalid",
            "commit",
            "-qm",
            "init",
        ],
    )
}

fn build_graph(projects: &[&str]) -> DependencyGraph {
    let nodes = projects
        .iter()
        .map(|project| ModuleNode {
            path: format!("{project}/unit.test.ts"),
            language: "typescript".into(),
            declarations: Vec::new(),
            references: Vec::new(),
            imports: Vec::new(),
        })
        .collect();
    let evidence = projects
        .iter()
        .map(|project| ChangedModuleEvidence {
            path: format!("{project}/unit.test.ts"),
            changed_exports: BTreeSet::new(),
            every_hunk_is_attributed: true,
            semantic_change: true,
            type_only_change: false,
            module_eval_changed: false,
        })
        .collect();
    DependencyGraph::new(nodes, Vec::new()).with_changed_module_evidence(evidence)
}

fn write_fake_vitest(dir: &Path) -> Result<(), Box<dyn Error>> {
    fs::write(
        dir.join("fake-vitest.mjs"),
        r#"
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const logFile = process.env.FAKE_VITEST_LOG;
if (logFile) {
  appendFileSync(logFile, JSON.stringify({ cwd: process.cwd(), args, isolate: process.env.VITEST_ISOLATE ?? null }) + "\n");
}
if (process.env.FAKE_VITEST_CRASH === "1") {
  process.stderr.write("fatal vitest crash\n");
  process.exit(2);
}

let outputFile = null;
const files = [];
for (const arg of args) {
  if (arg.startsWith("--outputFile=")) outputFile = arg.slice("--outputFile=".length);
  else if (arg.endsWith(".test.ts")) files.push(arg);
}

const failPattern = process.env.FAKE_VITEST_FAIL_PATTERN || "";
const omitPattern = process.env.FAKE_VITEST_OMIT_PATTERN || "";
const durations = { a: 12, b: 34, c: 56, d: 78 };
const testResults = [];
let anyFailed = false;

for (const file of files) {
  if (omitPattern && file.includes(omitPattern)) continue;
  const abs = resolve(process.cwd(), file);
  const failed = Boolean(failPattern && file.includes(failPattern));
  if (failed) anyFailed = true;
  const key = Object.keys(durations).find((k) => file.startsWith(`${k}/`) || file.includes(`/${k}/`)) || "a";
  testResults.push({
    name: abs,
    status: failed ? "failed" : "passed",
    startTime: 1000,
    endTime: 1000 + durations[key],
    message: failed ? `suite failed for ${file}` : "",
    assertionResults: [{
      fullName: `${file} works`,
      status: failed ? "failed" : "passed",
      failureMessages: failed ? [`expected ${file} to pass`] : [],
    }],
  });
}

if (outputFile) {
  writeFileSync(outputFile, JSON.stringify({ success: !anyFailed, testResults }), "utf8");
}
process.stdout.write(`ran ${files.join(",")}\n`);
process.exit(anyFailed ? 1 : 0);
"#,
    )?;
    Ok(())
}

fn vitest_task_json(
    project: &str,
    log_path: &Path,
    extra_env: &[(&str, &str)],
    cache: bool,
) -> serde_json::Value {
    let mut env = serde_json::Map::new();
    env.insert(
        "FAKE_VITEST_LOG".into(),
        serde_json::Value::String(log_path.display().to_string()),
    );
    for (k, v) in extra_env {
        env.insert((*k).into(), serde_json::Value::String((*v).into()));
    }
    serde_json::json!({
        "id": format!("{project}:test"),
        "project": project,
        "kind": "test",
        "cache": cache,
        "execution": {
            "executable": "node",
            "args": ["fake-vitest.mjs", "run"],
            "env": env,
            "fileNarrowing": { "suffixes": [".test.ts"] },
            "batch": { "maxSize": 8, "groupKey": "vitest", "mode": "vitest-files" }
        },
        "dependsOn": [],
        "impact": { "mode": "reachability", "paths": [] }
    })
}

fn setup_repo(
    name: &str,
    projects: &[&str],
    tasks: Vec<serde_json::Value>,
) -> Result<(PathBuf, PathBuf), Box<dyn Error>> {
    let dir = std::env::temp_dir().join(format!("dads-vitest-batch-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    for project in projects {
        fs::create_dir_all(dir.join(project))?;
        fs::write(
            dir.join(format!("{project}/unit.test.ts")),
            format!("export const {project} = 1;\n"),
        )?;
    }
    git(&dir, &["init", "-q"])?;
    write_fake_vitest(&dir)?;
    let log = dir.join(".git/invocations.log");
    let task_ids: Vec<String> = projects.iter().map(|p| format!("{p}:test")).collect();
    let project_entries: Vec<serde_json::Value> = projects
        .iter()
        .map(|p| serde_json::json!({ "id": p, "root": p, "fallbackDependencies": [] }))
        .collect();
    let manifest = serde_json::json!({
        "schemaVersion": 1,
        "workspace": { "root": ".", "fullFallback": { "taskIds": task_ids } },
        "projects": project_entries,
        "tasks": tasks,
    });
    fs::write(
        dir.join("dads.testing.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    commit_all(&dir)?;
    for project in projects {
        fs::write(
            dir.join(format!("{project}/unit.test.ts")),
            format!("export const {project} = 2;\n"),
        )?;
    }
    Ok((dir, log))
}

fn run_narrowed(
    dir: &Path,
    graph: DependencyGraph,
    store: Option<&dyn TaskReceiptStore>,
) -> Result<dads_testing_core::OperationResult, Box<dyn Error>> {
    let resp = execute_request_with_graph_and_receipts(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Run,
            workspace_root: dir.display().to_string(),
            base: Some("HEAD".into()),
            jobs: Some(4),
            cache: true,
            ..NativeRequest::default()
        },
        Some(graph),
        store,
    );
    assert!(resp.ok, "{resp:?}");
    Ok(resp.result.ok_or("missing result")?)
}

#[test]
fn vitest_batching_groups_narrowed_tasks_and_attributes_durations() -> Result<(), Box<dyn Error>> {
    let projects = ["a", "b", "c"];
    let dir_preview =
        std::env::temp_dir().join(format!("dads-vitest-batch-happy-{}", std::process::id()));
    let log_path = dir_preview.join(".git/invocations.log");
    let tasks = projects
        .iter()
        .map(|p| vitest_task_json(p, &log_path, &[], true))
        .collect();
    let (dir, log) = setup_repo("happy", &projects, tasks)?;

    let store = MemoryReceiptStore::new();
    let op = run_narrowed(&dir, build_graph(&projects), Some(&store))?;
    let run = op.run.ok_or("missing run")?;
    assert_eq!(run.exit_code, 0);
    assert_eq!(run.counts.executed, 3);
    assert_eq!(run.counts.failed, 0);
    assert_eq!(fs::read_to_string(&log)?.lines().count(), 1);

    let durations: BTreeMap<&str, Option<u64>> = run
        .tasks
        .iter()
        .map(|t| (t.id.as_str(), t.duration_ms))
        .collect();
    assert_eq!(durations.get("a:test"), Some(&Some(12)));
    assert_eq!(durations.get("b:test"), Some(&Some(34)));
    assert_eq!(durations.get("c:test"), Some(&Some(56)));
    assert_eq!(store.count(), 3);

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn vitest_batching_attributes_partial_failure_and_caches_only_passing_tasks()
-> Result<(), Box<dyn Error>> {
    let projects = ["a", "b", "c"];
    let dir_preview = std::env::temp_dir().join(format!(
        "dads-vitest-batch-partial-fail-{}",
        std::process::id()
    ));
    let log_path = dir_preview.join(".git/invocations.log");
    let fail_env = [("FAKE_VITEST_FAIL_PATTERN", "b/unit.test.ts")];
    let tasks = projects
        .iter()
        .map(|p| vitest_task_json(p, &log_path, &fail_env, true))
        .collect();
    let (dir, log) = setup_repo("partial-fail", &projects, tasks)?;

    let store = MemoryReceiptStore::new();
    let run1 = run_narrowed(&dir, build_graph(&projects), Some(&store))?
        .run
        .ok_or("missing run1")?;
    assert_eq!(run1.exit_code, 1);
    assert_eq!(run1.counts.failed, 1);
    let by_id: BTreeMap<&str, _> = run1.tasks.iter().map(|t| (t.id.as_str(), t)).collect();
    assert_eq!(by_id["a:test"].status, "executed");
    assert_eq!(by_id["b:test"].status, "failed");
    assert!(
        by_id["b:test"]
            .stderr
            .as_ref()
            .is_some_and(|s| s.text.contains("expected b/unit.test.ts to pass"))
    );
    assert_eq!(by_id["c:test"].status, "executed");
    assert_eq!(fs::read_to_string(&log)?.lines().count(), 1);
    assert_eq!(store.count(), 2);

    // Second run: passing `a:test` and `c:test` hit cache; ONLY `b:test` re-runs.
    let run2 = run_narrowed(&dir, build_graph(&projects), Some(&store))?
        .run
        .ok_or("missing run2")?;
    assert_eq!(run2.counts.cached, 2);
    assert_eq!(run2.counts.failed, 1);
    let by_id2: BTreeMap<&str, _> = run2.tasks.iter().map(|t| (t.id.as_str(), t)).collect();
    assert!(by_id2["a:test"].cached);
    assert!(!by_id2["b:test"].cached);
    assert!(by_id2["c:test"].cached);
    assert_eq!(fs::read_to_string(&log)?.lines().count(), 2);

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn vitest_batching_isolates_incompatible_env_and_uncached_and_non_narrowed_tasks()
-> Result<(), Box<dyn Error>> {
    let projects = ["a", "b", "c", "d"];
    let dir_preview = std::env::temp_dir().join(format!(
        "dads-vitest-batch-isolation-{}",
        std::process::id()
    ));
    let log_path = dir_preview.join(".git/invocations.log");
    let tasks = vec![
        vitest_task_json("a", &log_path, &[], true),
        vitest_task_json("b", &log_path, &[], true),
        vitest_task_json("c", &log_path, &[("VITEST_ISOLATE", "1")], true),
        vitest_task_json("d", &log_path, &[], false),
    ];
    let (dir, log) = setup_repo("isolation", &projects, tasks)?;

    let run = run_narrowed(&dir, build_graph(&projects), None)?
        .run
        .ok_or("missing run")?;
    assert_eq!(run.exit_code, 0);
    assert_eq!(run.counts.executed, 4);

    let log_text = fs::read_to_string(&log)?;
    let lines: Vec<&str> = log_text.lines().collect();
    assert_eq!(lines.len(), 3, "expected [a,b], [c], [d]:\n{log_text}");
    assert!(
        lines
            .iter()
            .any(|l| l.contains("a/unit.test.ts") && l.contains("b/unit.test.ts"))
    );
    assert!(
        lines
            .iter()
            .any(|l| l.contains("c/unit.test.ts") && !l.contains("a/unit.test.ts"))
    );
    assert!(
        lines
            .iter()
            .any(|l| l.contains("d/unit.test.ts") && !l.contains("a/unit.test.ts"))
    );

    let _ = fs::remove_file(&log);
    let full = execute_request_with_graph_and_receipts(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Run,
            workspace_root: dir.display().to_string(),
            all: true,
            jobs: Some(4),
            ..NativeRequest::default()
        },
        Some(build_graph(&projects)),
        None,
    );
    assert!(full.ok, "{full:?}");
    assert_eq!(fs::read_to_string(&log)?.lines().count(), 4);

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn vitest_batching_fails_safe_on_crash() -> Result<(), Box<dyn Error>> {
    let projects = ["a", "b"];
    let dir_preview =
        std::env::temp_dir().join(format!("dads-vitest-batch-crash-{}", std::process::id()));
    let log_path = dir_preview.join(".git/invocations.log");
    let crash_env = [("FAKE_VITEST_CRASH", "1")];
    let tasks = projects
        .iter()
        .map(|p| vitest_task_json(p, &log_path, &crash_env, true))
        .collect();
    let (dir, _) = setup_repo("crash", &projects, tasks)?;

    let store = MemoryReceiptStore::new();
    let run = run_narrowed(&dir, build_graph(&projects), Some(&store))?
        .run
        .ok_or("missing run")?;
    assert_eq!(run.exit_code, 1);
    assert_eq!(run.counts.failed, 2);
    assert_eq!(store.count(), 0);
    for task in &run.tasks {
        assert_eq!(task.status, "failed");
        assert!(
            task.error
                .as_deref()
                .is_some_and(|e| e.contains("JSON report"))
        );
    }

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn vitest_batching_fails_safe_on_missing_file_report() -> Result<(), Box<dyn Error>> {
    let projects = ["a", "b"];
    let dir_preview =
        std::env::temp_dir().join(format!("dads-vitest-batch-omit-{}", std::process::id()));
    let log_path = dir_preview.join(".git/invocations.log");
    let omit_env = [("FAKE_VITEST_OMIT_PATTERN", "b/unit.test.ts")];
    let tasks = projects
        .iter()
        .map(|p| vitest_task_json(p, &log_path, &omit_env, true))
        .collect();
    let (dir, _) = setup_repo("omit", &projects, tasks)?;

    let store = MemoryReceiptStore::new();
    let run = run_narrowed(&dir, build_graph(&projects), Some(&store))?
        .run
        .ok_or("missing run")?;
    assert_eq!(run.exit_code, 1);
    assert_eq!(run.counts.failed, 1);
    let by_id: BTreeMap<&str, _> = run.tasks.iter().map(|t| (t.id.as_str(), t)).collect();
    assert_eq!(by_id["a:test"].status, "executed");
    assert_eq!(by_id["b:test"].status, "failed");
    assert!(
        by_id["b:test"]
            .error
            .as_deref()
            .is_some_and(|e| e.contains("b/unit.test.ts"))
    );
    assert_eq!(store.count(), 1);

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn vitest_batching_runs_from_workspace_root_when_member_cwds_differ() -> Result<(), Box<dyn Error>>
{
    let projects = ["a", "b"];
    let dir_preview =
        std::env::temp_dir().join(format!("dads-vitest-batch-diff-cwd-{}", std::process::id()));
    let log_path = dir_preview.join(".git/invocations.log");
    let mut task_a = vitest_task_json("a", &log_path, &[], true);
    let mut task_b = vitest_task_json("b", &log_path, &[], true);
    task_a["execution"]["cwd"] = serde_json::json!("a");
    task_b["execution"]["cwd"] = serde_json::json!("b");
    let (dir, log) = setup_repo("diff-cwd", &projects, vec![task_a, task_b])?;

    let run = run_narrowed(&dir, build_graph(&projects), None)?
        .run
        .ok_or("missing run")?;
    assert_eq!(run.exit_code, 0);
    assert_eq!(run.counts.executed, 2);
    let log_text = fs::read_to_string(&log)?;
    let lines: Vec<&str> = log_text.lines().collect();
    assert_eq!(lines.len(), 1);
    let entry: serde_json::Value = serde_json::from_str(lines[0])?;
    assert_eq!(
        PathBuf::from(entry["cwd"].as_str().ok_or("cwd")?),
        fs::canonicalize(&dir)?
    );

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn discover_auto_vitest_batching_wires_vitest_files_mode() -> Result<(), Box<dyn Error>> {
    let dir = std::env::temp_dir().join(format!("dads-vitest-discover-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("packages/a"))?;
    fs::create_dir_all(dir.join("packages/b"))?;
    fs::write(
        dir.join("packages/a/package.json"),
        r#"{ "name": "a", "scripts": { "test": "vitest run" } }"#,
    )?;
    fs::write(
        dir.join("packages/b/package.json"),
        r#"{ "name": "b", "scripts": { "test": "vitest run" } }"#,
    )?;
    fs::write(
        dir.join("packages/b/vitest.config.ts"),
        "export default { test: { setupFiles: getSetup() } };\n",
    )?;
    fs::write(
        dir.join("dads.testing.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "schemaVersion": 1,
            "workspace": {
                "root": ".",
                "discover": {
                    "projectFiles": ["packages/*/package.json"],
                    "targetTemplates": [{
                        "target": "test",
                        "kind": "test",
                        "when": { "hasTarget": "test" },
                        "execution": { "executable": "npx", "args": ["vitest"], "cwd": "{projectRoot}" },
                        "autoVitestNarrowing": true,
                        "autoVitestBatching": true,
                        "impact": { "mode": "reachability" }
                    }]
                }
            }
        }))?,
    )?;
    git(&dir, &["init", "-q"])?;
    commit_all(&dir)?;

    let resp = execute_request(NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::ExpandManifest,
        workspace_root: dir.display().to_string(),
        ..NativeRequest::default()
    });
    assert!(resp.ok, "{resp:?}");
    let expanded = resp
        .result
        .ok_or("missing result")?
        .manifest
        .ok_or("missing manifest")?;
    let tasks = expanded["tasks"].as_array().ok_or("tasks array")?;
    let task_a = tasks
        .iter()
        .find(|t| t["id"] == "a:test")
        .ok_or("missing a:test")?;
    let task_b = tasks
        .iter()
        .find(|t| t["id"] == "b:test")
        .ok_or("missing b:test")?;
    assert_eq!(task_a["execution"]["batch"]["mode"], "vitest-files");
    assert_eq!(task_a["execution"]["batch"]["groupKey"], "vitest:test");
    assert_eq!(task_a["execution"]["batch"]["maxSize"], 16);
    assert!(task_b["execution"].get("batch").is_none());

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}
