#![allow(clippy::unwrap_used, clippy::expect_used)]

use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, TaskReceiptEntry, TaskReceiptRequest,
    TaskReceiptStore, execute_request_with_graph_and_receipts,
};
use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

struct CountingMissStore {
    lookups: AtomicUsize,
    lookups_by_key: Mutex<BTreeMap<String, usize>>,
}

impl CountingMissStore {
    fn new() -> Self {
        Self {
            lookups: AtomicUsize::new(0),
            lookups_by_key: Mutex::new(BTreeMap::new()),
        }
    }
}

impl TaskReceiptStore for CountingMissStore {
    fn compute_key(&self, request: &TaskReceiptRequest<'_>) -> Option<String> {
        Some(format!("key-{}", request.task_id))
    }

    fn lookup(&self, key: &str) -> Option<TaskReceiptEntry> {
        self.lookups.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut guard) = self.lookups_by_key.lock() {
            *guard.entry(key.to_owned()).or_insert(0) += 1;
        }
        None
    }

    fn record_pass(&self, _key: &str, _entry: &TaskReceiptEntry) {}
}

#[test]
fn scheduler_checks_receipt_cache_at_most_once_per_ready_task() -> Result<(), Box<dyn Error>> {
    let dir =
        std::env::temp_dir().join(format!("dads-scheduler-lookup-once-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let task_count = 10;
    let mut projects = Vec::new();
    let mut tasks = Vec::new();
    let mut fallback_ids = Vec::new();
    for i in 0..task_count {
        let proj = format!("p{i}");
        let task_id = format!("{proj}:test");
        fs::create_dir_all(dir.join(&proj))?;
        fs::write(dir.join(&proj).join("index.ts"), "export const x = 1;\n")?;
        fallback_ids.push(format!("\"{task_id}\""));
        projects.push(format!(
            r#"{{"id":"{proj}","root":"{proj}","fallbackDependencies":[]}}"#
        ));
        tasks.push(format!(
            r#"{{"id":"{task_id}","project":"{proj}","kind":"test","execution":{{"executable":"sh","args":["-c","true"],"cwd":"{proj}"}},"dependsOn":[],"impact":{{"mode":"project","paths":["{proj}/index.ts"]}}}}"#
        ));
    }
    let manifest = format!(
        r#"{{"schemaVersion":1,"workspace":{{"root":".","fullFallback":{{"taskIds":[{}]}}}},"projects":[{}],"tasks":[{}]}}"#,
        fallback_ids.join(","),
        projects.join(","),
        tasks.join(",")
    );
    fs::write(dir.join("dads.testing.json"), manifest)?;

    let store = CountingMissStore::new();
    let response = execute_request_with_graph_and_receipts(
        NativeRequest {
            schema_version: PROTOCOL_SCHEMA_VERSION,
            operation: Operation::Run,
            workspace_root: dir.to_string_lossy().into_owned(),
            manifest_path: Some("dads.testing.json".to_owned()),
            only: true,
            task_ids: (0..task_count).map(|i| format!("p{i}:test")).collect(),
            jobs: Some(2),
            cache: true,
            ..NativeRequest::default()
        },
        None,
        Some(&store),
    );
    assert!(response.ok, "unexpected failure: {:?}", response.error);
    let Some(run) = response.result.and_then(|r| r.run) else {
        return Err("expected Run payload".into());
    };
    assert_eq!(run.exit_code, 0);
    assert_eq!(run.counts.executed, task_count);

    // Must be O(N) = 10 lookups (1 per task), NEVER O(N^2) = 10 + 8 + 6 + 4 + 2 = 30!
    assert_eq!(store.lookups.load(Ordering::SeqCst), task_count);
    let per_key = store.lookups_by_key.lock().unwrap();
    assert_eq!(per_key.len(), task_count);
    for (key, count) in per_key.iter() {
        assert_eq!(*count, 1, "task {key} was looked up {count} times");
    }

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}
