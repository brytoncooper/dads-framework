#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::too_many_lines
)]

use dads_testing_core::graph::{
    DependencyGraph, GraphUncertainty, ImportFact, ImportKind, ModuleNode, SourceSpan,
};
use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, TaskReceiptEntry, TaskReceiptRequest,
    TaskReceiptStore, execute_request_with_graph,
};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fs;
use std::path::PathBuf;
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
    assert_eq!(
        reads.len(),
        1,
        "expected exactly 1 per-file undeclared read, got {reads:?}"
    );
    assert_eq!(reads[0].path, "libs/shared/helper.mjs");
    assert_eq!(
        reads[0].selected_file.as_deref(),
        Some("scripts/b.test.mjs")
    );
    Ok(())
}
