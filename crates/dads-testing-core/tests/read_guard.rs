#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::too_many_lines
)]

use dads_testing_core::graph::{
    ChangedModuleEvidence, DependencyGraph, GraphUncertainty, GraphUncertaintyScope, ImportFact,
    ImportKind, ModuleNode, SourceSpan,
};
use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, TaskReceiptEntry, TaskReceiptRequest,
    TaskReceiptStore, execute_request_with_graph, execute_request_with_graph_and_receipts,
};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

struct TempWorkspace(PathBuf);

impl TempWorkspace {
    fn new(prefix: &str) -> Result<Self, Box<dyn Error>> {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let seq = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "dads-rg-{prefix}-{}-{nanos}-{seq}",
            std::process::id()
        ));
        fs::create_dir_all(&dir)?;
        let canonical = fs::canonicalize(&dir)?;
        Ok(Self(canonical))
    }

    fn write(&self, rel: &str, contents: &str) -> Result<(), Box<dyn Error>> {
        let full = self.0.join(rel);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(full, contents)?;
        Ok(())
    }

    fn init_git(&self) -> Result<(), Box<dyn Error>> {
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.name", "Test"],
            vec!["config", "user.email", "test@example.invalid"],
            vec!["add", "."],
            vec!["commit", "-qm", "baseline"],
        ] {
            let status = Command::new("git")
                .args(&args)
                .current_dir(&self.0)
                .status()?;
            assert!(status.success(), "git {args:?} failed");
        }
        Ok(())
    }
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
struct MemoryReceipts {
    entries: Mutex<BTreeMap<String, TaskReceiptEntry>>,
    writes: AtomicUsize,
}

impl MemoryReceipts {
    fn count_for(&self, prefix: &str) -> usize {
        self.entries
            .lock()
            .unwrap()
            .keys()
            .filter(|k| k.starts_with(prefix))
            .count()
    }
}

fn find_task<'a>(
    run: &'a dads_testing_core::RunResult,
    id: &str,
) -> Result<&'a dads_testing_core::TaskRunResult, Box<dyn Error>> {
    run.tasks
        .iter()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("missing task {id}").into())
}

fn extract_run(
    resp: dads_testing_core::NativeResponse,
) -> Result<dads_testing_core::RunResult, Box<dyn Error>> {
    assert!(resp.ok, "{resp:?}");
    Ok(resp
        .result
        .ok_or("missing result")?
        .run
        .ok_or("missing run")?)
}

impl TaskReceiptStore for MemoryReceipts {
    fn compute_key(&self, req: &TaskReceiptRequest<'_>) -> Option<String> {
        Some(format!(
            "{}:{}:{:?}:{:?}",
            req.task_id, req.project, req.impact_paths, req.extra_files
        ))
    }

    fn lookup(&self, key: &str) -> Option<TaskReceiptEntry> {
        self.entries
            .lock()
            .ok()
            .and_then(|map| map.get(key).cloned())
    }

    fn record_pass(&self, key: &str, entry: &TaskReceiptEntry) {
        self.writes.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut map) = self.entries.lock() {
            map.insert(key.to_owned(), entry.clone());
        }
    }
}

fn manifest_json(enforce_default: bool, impact_paths: &[&str], ignore_paths: &[&str]) -> String {
    serde_json::json!({
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "fullFallback": { "taskIds": ["web:test", "web:lint"] },
            "ignorePaths": ignore_paths,
            "enforceDeclaredReads": enforce_default
        },
        "projects": [
            { "id": "web", "root": "apps/web", "fallbackDependencies": [] }
        ],
        "tasks": [
            {
                "id": "web:test",
                "project": "web",
                "kind": "test",
                "execution": { "executable": "node", "args": ["apps/web/src/reader.test.mjs"] },
                "dependsOn": [],
                "impact": { "mode": "reachability", "paths": impact_paths }
            },
            {
                "id": "web:lint",
                "project": "web",
                "kind": "lint",
                "execution": { "executable": "node", "args": ["-e", "if (process.env.DADS_TEST_READ_GUARD_CONFIG) process.exit(42);"] },
                "dependsOn": [],
                "impact": { "mode": "project", "paths": [] }
            }
        ]
    })
    .to_string()
}

fn mod_node(path: &str, imports: &[&str]) -> ModuleNode {
    ModuleNode {
        path: path.to_owned(),
        language: "javascript".to_owned(),
        declarations: Vec::new(),
        references: Vec::new(),
        imports: imports
            .iter()
            .map(|target| ImportFact {
                specifier: (*target).to_owned(),
                span: SourceSpan { start: 0, end: 1 },
                kind: ImportKind::Static,
                type_only: false,
                requested_symbols: BTreeSet::new(),
                namespace_import: true,
                reexport_all: false,
                reexport_namespace: None,
                resolved_path: Some((*target).to_owned()),
                position: None,
                export_deps: None,
                member_reads: None,
            })
            .collect(),
    }
}

fn simple_graph_for_web(
    uncertainties: Vec<GraphUncertainty>,
    extra_imports: Vec<&str>,
) -> DependencyGraph {
    let mut nodes = vec![mod_node("apps/web/src/reader.test.mjs", &extra_imports)];
    for target in extra_imports {
        nodes.push(mod_node(target, &[]));
    }
    DependencyGraph::new(nodes, uncertainties)
}

#[test]
fn enforce_lists_multiple_violations_blocks_cache_and_passes_once_declared()
-> Result<(), Box<dyn Error>> {
    let ws = TempWorkspace::new("multi-violation")?;
    ws.write("package.json", r#"{"name":"rg-fixture"}"#)?;
    ws.write("settings/flags.json", r#"{"enabled":true}"#)?;
    ws.write("secrets/token.txt", "abc")?;
    ws.write("ignored/notes.txt", "ok")?;
    ws.write("oxc-static/known.json", r#"{"known":1}"#)?;
    ws.write("fs-watched/item.txt", "watched")?;
    ws.write(
        "apps/web/src/reader.test.mjs",
        concat!(
            "import { readFileSync, existsSync } from 'node:fs';\n",
            "import { readFile } from 'node:fs/promises';\n",
            "readFileSync('package.json', 'utf8');\n",
            "readFileSync('ignored/notes.txt', 'utf8');\n",
            "readFileSync('oxc-static/known.json', 'utf8');\n",
            "readFileSync('fs-watched/item.txt', 'utf8');\n",
            "readFileSync('settings/flags.json', 'utf8');\n",
            "await readFile('secrets/token.txt', 'utf8');\n",
            "existsSync('settings/missing-sentinel.json');\n",
        ),
    )?;
    ws.write(
        "dads.testing.json",
        &manifest_json(false, &[], &["ignored/**"]),
    )?;
    ws.init_git()?;

    let graph = simple_graph_for_web(
        Vec::new(),
        vec!["oxc-static/known.json", "fs-dir:fs-watched"],
    );
    let store = MemoryReceipts::default();

    // Run 1: enforce ON, cache ON -> fails with all 3 undeclared reads in one run and 0 cache writes.
    let resp = execute_request_with_graph_and_receipts(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Run,
            workspace_root: ws.0.to_string_lossy().into_owned(),
            only: true,
            task_ids: vec!["web:test".into(), "web:lint".into()],
            cache: true,
            enforce_declared_reads: true,
            ..NativeRequest::default()
        },
        Some(graph.clone()),
        Some(&store),
    );
    let run = extract_run(resp)?;
    assert_eq!(run.exit_code, 1);

    let lint = find_task(&run, "web:lint")?;
    assert_eq!(
        lint.status, "executed",
        "non-test task must never receive read guard"
    );

    let test = find_task(&run, "web:test")?;
    assert_eq!(test.status, "failed");
    assert_eq!(test.exit_code, Some(1));
    let paths: Vec<&str> = test
        .undeclared_reads
        .iter()
        .map(|r| r.path.as_str())
        .collect();
    assert_eq!(
        paths,
        vec![
            "secrets/token.txt",
            "settings/flags.json",
            "settings/missing-sentinel.json"
        ]
    );
    assert_eq!(
        test.undeclared_reads[1].location.as_deref(),
        Some("apps/web/src/reader.test.mjs:7")
    );
    let stderr = test.stderr.as_ref().ok_or("missing stderr")?.text.as_str();
    assert!(stderr.contains("UNDECLARED WORKSPACE READS in web:test:"));
    assert!(stderr.contains("- settings/flags.json  (read at apps/web/src/reader.test.mjs:7)"));
    assert!(stderr.contains("npx dad-test audit --fix --task web:test"));
    assert_eq!(
        store.count_for("web:test:"),
        0,
        "violating task must never write a cache receipt"
    );

    // Declare the missing paths -> run passes and writes a receipt, then hits cache on replay.
    ws.write(
        "dads.testing.json",
        &manifest_json(
            false,
            &["settings/**", "secrets/token.txt"],
            &["ignored/**"],
        ),
    )?;
    let pass_run = extract_run(execute_request_with_graph_and_receipts(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Run,
            workspace_root: ws.0.to_string_lossy().into_owned(),
            only: true,
            task_ids: vec!["web:test".into()],
            cache: true,
            enforce_declared_reads: true,
            ..NativeRequest::default()
        },
        Some(graph.clone()),
        Some(&store),
    ))?;
    assert_eq!(pass_run.exit_code, 0);
    assert!(pass_run.tasks[0].undeclared_reads.is_empty());
    assert!(!pass_run.tasks[0].cached);

    let cached_run = extract_run(execute_request_with_graph_and_receipts(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Run,
            workspace_root: ws.0.to_string_lossy().into_owned(),
            only: true,
            task_ids: vec!["web:test".into()],
            cache: true,
            enforce_declared_reads: true,
            ..NativeRequest::default()
        },
        Some(graph),
        Some(&store),
    ))?;
    assert_eq!(cached_run.exit_code, 0);
    assert!(
        cached_run.tasks[0].cached,
        "clean enforced run must cache and replay"
    );
    Ok(())
}

#[test]
fn manifest_enforce_default_and_no_enforce_override_and_audit_mode() -> Result<(), Box<dyn Error>> {
    let ws = TempWorkspace::new("manifest-override")?;
    ws.write("secret/data.json", r#"{"v":1}"#)?;
    ws.write(
        "apps/web/src/reader.test.mjs",
        concat!(
            "import { readFileSync } from 'node:fs';\n",
            "readFileSync('secret/data.json', 'utf8');\n",
            "if (process.env.EXPECT_NO_GUARD === '1' && process.env.DADS_TEST_READ_GUARD_CONFIG) process.exit(99);\n",
        ),
    )?;
    ws.write("dads.testing.json", &manifest_json(true, &[], &[]))?;
    ws.init_git()?;
    let graph = simple_graph_for_web(Vec::new(), Vec::new());

    // Manifest `workspace.enforceDeclaredReads: true` enforces without CLI flag.
    let enforced_run = extract_run(execute_request_with_graph(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Run,
            workspace_root: ws.0.to_string_lossy().into_owned(),
            all: true,
            ..NativeRequest::default()
        },
        Some(graph.clone()),
    ))?;
    assert_eq!(enforced_run.exit_code, 1);
    let test_enforced = find_task(&enforced_run, "web:test")?;
    assert_eq!(test_enforced.status, "failed");
    assert_eq!(test_enforced.undeclared_reads.len(), 1);
    assert_eq!(test_enforced.undeclared_reads[0].path, "secret/data.json");

    // `--no-enforce-declared-reads` disables preload completely (zero overhead).
    let disabled_run = extract_run(execute_request_with_graph(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Run,
            workspace_root: ws.0.to_string_lossy().into_owned(),
            all: true,
            no_enforce_declared_reads: true,
            ..NativeRequest::default()
        },
        Some(graph.clone()),
    ))?;
    assert_eq!(disabled_run.exit_code, 0);
    assert!(
        find_task(&disabled_run, "web:test")?
            .undeclared_reads
            .is_empty()
    );

    // Audit mode overrides manifest enforce: records undeclared reads WITHOUT failing the task.
    let audited_run = extract_run(execute_request_with_graph(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Run,
            workspace_root: ws.0.to_string_lossy().into_owned(),
            all: true,
            audit_reads: true,
            ..NativeRequest::default()
        },
        Some(graph),
    ))?;
    assert_eq!(audited_run.exit_code, 0);
    let test_audited = find_task(&audited_run, "web:test")?;
    assert_eq!(test_audited.status, "executed");
    assert_eq!(test_audited.undeclared_reads.len(), 1);
    assert_eq!(test_audited.undeclared_reads[0].path, "secret/data.json");
    assert_eq!(
        test_audited.undeclared_reads[0].location.as_deref(),
        Some("apps/web/src/reader.test.mjs:2")
    );
    Ok(())
}

#[test]
fn option3_unresolved_fs_read_cacheability_toggles_with_enforce_and_manifest()
-> Result<(), Box<dyn Error>> {
    let ws = TempWorkspace::new("option3-cache")?;
    ws.write("apps/web/src/reader.test.mjs", "export const ok = 1;\n")?;
    ws.write("dads.testing.json", &manifest_json(false, &[], &[]))?;
    ws.init_git()?;

    let graph = simple_graph_for_web(
        vec![GraphUncertainty {
            code: "unresolved-fs-read".into(),
            message: "dynamic fs read".into(),
            path: "apps/web/src/reader.test.mjs".into(),
            scope: GraphUncertaintyScope::ReachedModule,
            location: None,
        }],
        Vec::new(),
    );

    let plan_cacheable =
        |ws_root: &Path, enforce: bool, no_enforce: bool| -> Result<bool, Box<dyn Error>> {
            let resp = execute_request_with_graph(
                NativeRequest {
                    schema_version: PROTOCOL_SCHEMA_VERSION,
                    operation: Operation::Plan,
                    workspace_root: ws_root.to_string_lossy().into_owned(),
                    only: true,
                    task_ids: vec!["web:test".into()],
                    enforce_declared_reads: enforce,
                    no_enforce_declared_reads: no_enforce,
                    ..NativeRequest::default()
                },
                Some(graph.clone()),
            );
            assert!(resp.ok, "{resp:?}");
            let plan = resp.result.ok_or("missing result")?.plan;
            let task = plan
                .tasks
                .iter()
                .find(|t| t.id == "web:test")
                .ok_or("missing web:test")?;
            Ok(task
                .cache_inputs
                .as_ref()
                .ok_or("missing cache_inputs")?
                .cacheable)
        };

    // Enforce OFF -> fail closed (`cacheable: false`).
    assert!(!plan_cacheable(&ws.0, false, false)?);
    // CLI `--enforce-declared-reads` -> Option 3 unlocks `cacheable: true`.
    assert!(plan_cacheable(&ws.0, true, false)?);

    // Manifest `workspace.enforceDeclaredReads: true` -> unlocks `cacheable: true`.
    ws.write("dads.testing.json", &manifest_json(true, &[], &[]))?;
    assert!(plan_cacheable(&ws.0, false, false)?);
    // CLI `--no-enforce-declared-reads` overrides manifest back to fail-closed `cacheable: false`.
    assert!(!plan_cacheable(&ws.0, false, true)?);
    Ok(())
}

#[test]
fn vitest_batch_isolates_members_on_undeclared_read_in_enforce_mode() -> Result<(), Box<dyn Error>>
{
    let ws = TempWorkspace::new("vitest-batch-rg")?;
    ws.write("secret/leak.txt", "leak")?;
    ws.write(
        "fake-vitest.mjs",
        concat!(
            "import { appendFileSync, writeFileSync } from 'node:fs';\n",
            "import { pathToFileURL } from 'node:url';\n",
            "import path from 'node:path';\n",
            "const args = process.argv.slice(2);\n",
            "const outArg = args.find((a) => a.startsWith('--outputFile='));\n",
            "const files = args.filter((a) => !a.startsWith('-'));\n",
            "if (process.env.INVOCATION_LOG) appendFileSync(process.env.INVOCATION_LOG, JSON.stringify(files) + '\\n');\n",
            "const testResults = [];\n",
            "for (const file of files) {\n",
            "  const abs = path.resolve(file);\n",
            "  await import(pathToFileURL(abs).href);\n",
            "  testResults.push({ name: abs, status: 'passed', startTime: 1, endTime: 2, message: '', assertionResults: [] });\n",
            "}\n",
            "if (outArg) writeFileSync(outArg.slice('--outputFile='.length), JSON.stringify({ success: true, testResults }));\n",
        ),
    )?;
    let log_file = ws.0.join(".git/batch-invocations.log");
    let log_env = log_file.to_string_lossy().into_owned();
    ws.write(
        "apps/a/a.test.mjs",
        "import { readFileSync } from 'node:fs';\nreadFileSync('secret/leak.txt', 'utf8');\n",
    )?;
    ws.write("apps/b/b.test.mjs", "export const clean = true;\n")?;
    let mk_task = |proj: &str| {
        serde_json::json!({
            "id": format!("{proj}:test"),
            "project": proj,
            "kind": "test",
            "execution": {
                "executable": "node",
                "args": ["fake-vitest.mjs"],
                "env": { "INVOCATION_LOG": log_env },
                "fileNarrowing": { "suffixes": [".test.mjs"] },
                "batch": { "maxSize": 8, "mode": "vitest-files", "groupKey": "vt" }
            },
            "dependsOn": [],
            "impact": { "mode": "reachability", "paths": ["fake-vitest.mjs"] }
        })
    };
    ws.write(
        "dads.testing.json",
        &serde_json::json!({
            "schemaVersion": 1,
            "workspace": { "root": ".", "fullFallback": { "taskIds": ["a:test", "b:test"] } },
            "projects": [
                { "id": "a", "root": "apps/a", "fallbackDependencies": [] },
                { "id": "b", "root": "apps/b", "fallbackDependencies": [] }
            ],
            "tasks": [mk_task("a"), mk_task("b")]
        })
        .to_string(),
    )?;
    ws.init_git()?;
    // Modify both test files so both are selected with `selected_files` (eligible for Vitest batching).
    ws.write("apps/a/a.test.mjs", "import { readFileSync } from 'node:fs';\nreadFileSync('secret/leak.txt', 'utf8'); // edit\n")?;
    ws.write("apps/b/b.test.mjs", "export const clean = 2;\n")?;

    let evidence = ["apps/a/a.test.mjs", "apps/b/b.test.mjs"]
        .into_iter()
        .map(|p| ChangedModuleEvidence {
            path: p.into(),
            changed_exports: BTreeSet::new(),
            every_hunk_is_attributed: true,
            semantic_change: true,
            type_only_change: false,
            module_eval_changed: false,
            changed_type_exports: None,
        })
        .collect();
    let graph = DependencyGraph::new(
        vec![
            mod_node("apps/a/a.test.mjs", &[]),
            mod_node("apps/b/b.test.mjs", &[]),
        ],
        Vec::new(),
    )
    .with_changed_module_evidence(evidence);
    let store = MemoryReceipts::default();

    let resp = execute_request_with_graph_and_receipts(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Run,
            workspace_root: ws.0.to_string_lossy().into_owned(),
            base: Some("HEAD".into()),
            cache: true,
            enforce_declared_reads: true,
            ..NativeRequest::default()
        },
        Some(graph.clone()),
        Some(&store),
    );
    let run = extract_run(resp)?;
    let a = find_task(&run, "a:test")?;
    let b = find_task(&run, "b:test")?;
    assert_eq!(a.status, "failed", "only violating member a:test must fail");
    assert_eq!(a.undeclared_reads.len(), 1);
    assert_eq!(a.undeclared_reads[0].path, "secret/leak.txt");
    assert_eq!(
        b.status, "executed",
        "clean member b:test must pass after isolation"
    );
    assert!(b.undeclared_reads.is_empty());
    let enforce_calls: Vec<Vec<String>> = fs::read_to_string(&log_file)?
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        enforce_calls.len(),
        3,
        "expected 1 batched call + 2 isolated retries, got {enforce_calls:?}"
    );
    assert_eq!(enforce_calls[0].len(), 2, "first call must be batched");
    assert_eq!(
        store.count_for("b:test:"),
        1,
        "clean member b:test must still be cached"
    );
    assert_eq!(
        store.count_for("a:test:"),
        0,
        "violating member a:test must not be cached"
    );

    // Audit mode disables Vitest batching completely (exact per-task attribution on first try).
    let _ = fs::remove_file(&log_file);
    let audit_run = extract_run(execute_request_with_graph(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Run,
            workspace_root: ws.0.to_string_lossy().into_owned(),
            base: Some("HEAD".into()),
            audit_reads: true,
            ..NativeRequest::default()
        },
        Some(graph),
    ))?;
    assert_eq!(audit_run.exit_code, 0);
    let audit_calls: Vec<Vec<String>> = fs::read_to_string(&log_file)?
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(audit_calls.len(), 2, "audit must run each task standalone");
    assert!(audit_calls.iter().all(|files| files.len() == 1));
    assert_eq!(find_task(&audit_run, "a:test")?.undeclared_reads.len(), 1);
    assert!(find_task(&audit_run, "b:test")?.undeclared_reads.is_empty());
    Ok(())
}

#[test]
fn audit_per_file_catches_sibling_masked_undeclared_read_with_zero_false_positives()
-> Result<(), Box<dyn Error>> {
    let ws = TempWorkspace::new("audit-per-file")?;
    ws.write("libs/shared/helper.mjs", "export const v = 42;\n")?;
    ws.write("libs/other/other.mjs", "export const o = 99;\n")?;
    // Sibling a.test.mjs statically imports libs/shared/helper.mjs AND reads it legitimately.
    ws.write(
        "scripts/a.test.mjs",
        "import { v } from '../libs/shared/helper.mjs';\nif (v !== 42) throw new Error('bad');\n",
    )?;
    // Sibling b.test.mjs dynamically reads libs/shared/helper.mjs WITHOUT statically importing it.
    ws.write(
        "scripts/b.test.mjs",
        "import fs from 'node:fs';\nfs.readFileSync('libs/shared/helper.mjs', 'utf8');\n",
    )?;
    // Sibling c.test.mjs statically imports libs/other/other.mjs (distinct legitimate import).
    ws.write(
        "scripts/c.test.mjs",
        "import { o } from '../libs/other/other.mjs';\nif (o !== 99) throw new Error('bad');\n",
    )?;
    ws.write(
        "scripts/run.mjs",
        r#"
import { spawnSync } from 'node:child_process';
const files = process.argv.slice(2);
const targets = files.length > 0 ? files : ['scripts/a.test.mjs', 'scripts/b.test.mjs', 'scripts/c.test.mjs'];
for (const f of targets) {
  const res = spawnSync(process.execPath, [f], { stdio: 'inherit' });
  if (res.status !== 0) process.exit(res.status ?? 1);
}
"#,
    )?;
    ws.write(
        "dads.testing.json",
        &serde_json::to_string_pretty(&serde_json::json!({
            "schemaVersion": 1,
            "workspace": {
                "root": ".",
                "fullFallback": { "taskIds": ["scripts:test"] }
            },
            "projects": [
                { "id": "scripts", "root": "scripts" },
                { "id": "shared", "root": "libs/shared" },
                { "id": "other", "root": "libs/other" }
            ],
            "tasks": [{
                "id": "scripts:test",
                "project": "scripts",
                "kind": "test",
                "execution": {
                    "executable": "node",
                    "args": ["scripts/run.mjs"],
                    "fileNarrowing": { "suffixes": [".test.mjs"] }
                },
                "impact": { "mode": "reachability", "paths": [] },
                "cache": false
            }]
        }))?,
    )?;
    ws.init_git()?;

    let graph = DependencyGraph::new(
        vec![
            ModuleNode {
                path: "libs/shared/helper.mjs".into(),
                language: "javascript".into(),
                declarations: vec![],
                references: vec![],
                imports: vec![],
            },
            ModuleNode {
                path: "libs/other/other.mjs".into(),
                language: "javascript".into(),
                declarations: vec![],
                references: vec![],
                imports: vec![],
            },
            ModuleNode {
                path: "scripts/a.test.mjs".into(),
                language: "javascript".into(),
                declarations: vec![],
                references: vec![],
                imports: vec![ImportFact {
                    specifier: "../libs/shared/helper.mjs".into(),
                    span: SourceSpan { start: 0, end: 1 },
                    kind: ImportKind::Static,
                    type_only: false,
                    requested_symbols: BTreeSet::from(["v".into()]),
                    namespace_import: false,
                    reexport_all: false,
                    reexport_namespace: None,
                    resolved_path: Some("libs/shared/helper.mjs".into()),
                    position: None,
                    export_deps: None,
                    member_reads: None,
                }],
            },
            ModuleNode {
                path: "scripts/b.test.mjs".into(),
                language: "javascript".into(),
                declarations: vec![],
                references: vec![],
                imports: vec![],
            },
            ModuleNode {
                path: "scripts/c.test.mjs".into(),
                language: "javascript".into(),
                declarations: vec![],
                references: vec![],
                imports: vec![ImportFact {
                    specifier: "../libs/other/other.mjs".into(),
                    span: SourceSpan { start: 0, end: 1 },
                    kind: ImportKind::Static,
                    type_only: false,
                    requested_symbols: BTreeSet::from(["o".into()]),
                    namespace_import: false,
                    reexport_all: false,
                    reexport_namespace: None,
                    resolved_path: Some("libs/other/other.mjs".into()),
                    position: None,
                    export_deps: None,
                    member_reads: None,
                }],
            },
        ],
        vec![],
    );

    // Whole-task audit (audit_per_file = false) is masked by sibling a.test.mjs's static import!
    let whole_run = extract_run(execute_request_with_graph(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Run,
            workspace_root: ws.0.to_string_lossy().into_owned(),
            all: true,
            audit_reads: true,
            audit_per_file: false,
            ..NativeRequest::default()
        },
        Some(graph.clone()),
    ))?;
    assert!(
        find_task(&whole_run, "scripts:test")?
            .undeclared_reads
            .is_empty(),
        "whole-task audit should be masked by sibling static import"
    );

    // Per-file audit (audit_per_file = true) catches b.test.mjs with exact selected_file and zero
    // false positives for a.test.mjs or c.test.mjs!
    let per_file_run = extract_run(execute_request_with_graph(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Run,
            workspace_root: ws.0.to_string_lossy().into_owned(),
            all: true,
            audit_reads: true,
            audit_per_file: true,
            ..NativeRequest::default()
        },
        Some(graph),
    ))?;
    let reads = &find_task(&per_file_run, "scripts:test")?.undeclared_reads;
    assert_eq!(reads.len(), 1, "expected exactly 1 per-file undeclared read, got {reads:?}");
    assert_eq!(reads[0].path, "libs/shared/helper.mjs");
    assert_eq!(reads[0].selected_file.as_deref(), Some("scripts/b.test.mjs"));
    Ok(())
}
