//! Shared temporary workspace and recording receipt store helpers for store integration tests.

use dads_testing_core::graph::{
    ChangedModuleEvidence, DependencyGraph, ImportFact, ImportKind, ModuleNode, SourceSpan,
    SymbolFact,
};
use dads_testing_core::{
    NativeRequest, Operation, PlanResult, RunResult, TaskReceiptEntry, TaskReceiptRequest,
    TaskReceiptStore, execute_request_with_graph_and_receipts,
};
use dads_testing_store::FileReceiptStore;
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct RecordingStore {
    inner: FileReceiptStore,
    last_keys: Mutex<BTreeMap<String, Option<String>>>,
}

impl RecordingStore {
    pub fn new(cache_dir: &Path) -> Self {
        Self {
            inner: FileReceiptStore::for_cache_dir(cache_dir),
            last_keys: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn key_for(&self, task_id: &str) -> Option<String> {
        self.last_keys
            .lock()
            .ok()
            .and_then(|g| g.get(task_id).cloned().flatten())
    }

    #[allow(dead_code)]
    pub fn was_key_requested(&self, task_id: &str) -> bool {
        self.last_keys
            .lock()
            .ok()
            .is_some_and(|g| g.contains_key(task_id))
    }
}

impl TaskReceiptStore for RecordingStore {
    fn begin_run(&self) {
        self.inner.begin_run();
        if let Ok(mut guard) = self.last_keys.lock() {
            guard.clear();
        }
    }

    fn compute_key(&self, request: &TaskReceiptRequest<'_>) -> Option<String> {
        let key = self.inner.compute_key(request);
        if let Ok(mut guard) = self.last_keys.lock() {
            guard.insert(request.task_id.to_owned(), key.clone());
        }
        key
    }

    fn lookup(&self, key: &str) -> Option<TaskReceiptEntry> {
        self.inner.lookup(key)
    }

    fn record_pass(&self, key: &str, entry: &TaskReceiptEntry) {
        self.inner.record_pass(key, entry);
    }
}

pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(label: &str) -> Result<Self, Box<dyn Error>> {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "dads-store-inv-{label}-{}-{nonce}-{seq}",
            std::process::id()
        ));
        fs::create_dir_all(&dir)?;
        Ok(Self(dir))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn write_file(root: &Path, rel: &str, content: &str) -> Result<(), Box<dyn Error>> {
    let full = root.join(rel);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(full, content)?;
    Ok(())
}

pub fn git(dir: &Path, args: &[&str]) -> Result<(), Box<dyn Error>> {
    let status = Command::new("git").args(args).current_dir(dir).status()?;
    if !status.success() {
        return Err(format!("git {args:?} failed").into());
    }
    Ok(())
}

pub fn commit_all(dir: &Path) -> Result<(), Box<dyn Error>> {
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
            "base",
        ],
    )
}

pub fn mod_node(path: &str, exports: &[&str], imports: &[&str]) -> ModuleNode {
    ModuleNode {
        path: path.to_owned(),
        language: "typescript".to_owned(),
        declarations: exports
            .iter()
            .map(|name| SymbolFact {
                name: (*name).to_owned(),
                span: SourceSpan { start: 0, end: 1 },
            })
            .collect(),
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

pub fn changed_evidence(path: &str, export: &str) -> ChangedModuleEvidence {
    ChangedModuleEvidence {
        path: path.to_owned(),
        changed_exports: BTreeSet::from([export.to_owned()]),
        every_hunk_is_attributed: true,
        semantic_change: true,
        type_only_change: false,
        module_eval_changed: false,
        changed_type_exports: None,
    }
}

pub fn run_cached(
    root: &Path,
    req: NativeRequest,
    graph: Option<DependencyGraph>,
    store: &dyn TaskReceiptStore,
) -> Result<(PlanResult, RunResult), Box<dyn Error>> {
    let resp = execute_request_with_graph_and_receipts(
        NativeRequest {
            workspace_root: root.to_string_lossy().into_owned(),
            operation: Operation::Run,
            cache: true,
            jobs: Some(1),
            ..req
        },
        graph,
        Some(store),
    );
    if !resp.ok {
        return Err(format!("run failed: {resp:?}").into());
    }
    let res = resp.result.ok_or("missing result")?;
    Ok((res.plan, res.run.ok_or("missing run")?))
}
