use crate::cache_dir::resolve_cache_dir;
use crate::receipts::FileReceiptStore;
use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, RunResult, TaskOutput, TaskReceiptEntry,
    TaskReceiptStore, execute_request_with_graph_and_receipts,
};
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::thread;

fn git(dir: &Path, args: &[&str]) -> Result<(), Box<dyn Error>> {
    let status = Command::new("git").args(args).current_dir(dir).status()?;
    assert!(status.success(), "git {args:?} failed");
    Ok(())
}

fn temp_repo(name: &str) -> Result<PathBuf, Box<dyn Error>> {
    let dir = std::env::temp_dir().join(format!(
        "dads-testing-receipts-{name}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("src"))?;
    git(&dir, &["init", "-q"])?;
    fs::write(dir.join("tsconfig.json"), "{}\n")?;
    fs::write(dir.join("src/a.ts"), "export const v = 1;\n")?;
    Ok(dir)
}

fn write_manifest(dir: &Path, command: &str) -> Result<(), Box<dyn Error>> {
    let manifest = serde_json::json!({
        "schemaVersion": 1,
        "workspace": { "root": ".", "fullFallback": { "taskIds": ["app:test"] } },
        "projects": [{ "id": "app", "root": "src", "fallbackDependencies": [] }],
        "tasks": [{
            "id": "app:test",
            "project": "app",
            "kind": "test",
            "execution": { "executable": "sh", "args": ["-c", command] },
            "dependsOn": [],
            "impact": { "mode": "project", "paths": [] }
        }]
    });
    fs::write(
        dir.join("dads.testing.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    Ok(())
}

fn run_with_cache(
    dir: &Path,
    cache: bool,
    store: &FileReceiptStore,
) -> Result<RunResult, Box<dyn Error>> {
    let req = NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Run,
        workspace_root: dir.display().to_string(),
        manifest_path: None,
        base: None,
        head: None,
        all: false,
        only: true,
        task_ids: vec!["app:test".to_owned()],
        task_kinds: Vec::new(),
        shard: None,
        jobs: Some(1),
        cache,
        remote_cache_url: None,
        ..NativeRequest::default()
    };
    let resp = execute_request_with_graph_and_receipts(req, None, Some(store));
    assert!(resp.ok, "{resp:?}");
    let run = resp
        .result
        .and_then(|result| result.run)
        .ok_or("missing run result")?;
    Ok(run)
}

#[test]
fn receipts_hit_when_unchanged_and_invalidate_on_source_policy_command_or_corruption()
-> Result<(), Box<dyn Error>> {
    let dir = temp_repo("full-lifecycle")?;
    let counter = dir.join(".git/counter.txt");
    let cmd = format!(
        "printf x >> '{}' && printf 'hello-receipt'",
        counter.display()
    );
    write_manifest(&dir, &cmd)?;
    git(&dir, &["add", "."])?;
    git(
        &dir,
        &[
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@e.invalid",
            "commit",
            "-qm",
            "base",
        ],
    )?;

    let store = FileReceiptStore::for_workspace(&dir).ok_or("missing git receipt store")?;

    // 1. First cached run executes once and records receipt
    let r1 = run_with_cache(&dir, true, &store)?;
    assert_eq!(r1.exit_code, 0);
    assert_eq!(r1.counts.cached, 0);
    assert!(!r1.tasks[0].cached);
    assert_eq!(fs::read_to_string(&counter)?.len(), 1);

    // 2. Second cached run hits receipt without spawning child process
    let r2 = run_with_cache(&dir, true, &store)?;
    assert_eq!(r2.exit_code, 0);
    assert_eq!(r2.counts.cached, 1);
    assert!(r2.tasks[0].cached);
    assert_eq!(
        r2.tasks[0].stdout.as_ref().map(|o| o.text.as_str()),
        Some("hello-receipt")
    );
    assert_eq!(fs::read_to_string(&counter)?.len(), 1);

    // 3. `--no-cache` (`cache: false`) always re-executes even with valid receipt on disk
    let r3 = run_with_cache(&dir, false, &store)?;
    assert_eq!(r3.counts.cached, 0);
    assert!(!r3.tasks[0].cached);
    assert_eq!(fs::read_to_string(&counter)?.len(), 2);

    // 4. Editing a source file invalidates receipt
    fs::write(dir.join("src/a.ts"), "export const v = 2;\n")?;
    let r4 = run_with_cache(&dir, true, &store)?;
    assert_eq!(r4.counts.cached, 0);
    assert_eq!(fs::read_to_string(&counter)?.len(), 3);

    // 5. Editing a policy file (`tsconfig.json`) invalidates receipt
    fs::write(dir.join("tsconfig.json"), "{\"strict\":true}\n")?;
    let r5 = run_with_cache(&dir, true, &store)?;
    assert_eq!(r5.counts.cached, 0);
    assert_eq!(fs::read_to_string(&counter)?.len(), 4);

    // 6. Corrupting persisted receipts fails closed (misses and re-executes)
    for entry in fs::read_dir(store.receipts_dir())? {
        fs::write(entry?.path(), "{corrupt")?;
    }
    let r6 = run_with_cache(&dir, true, &store)?;
    assert_eq!(r6.counts.cached, 0);
    assert_eq!(fs::read_to_string(&counter)?.len(), 5);

    // 7. Failing runs NEVER write receipts
    write_manifest(&dir, "exit 1")?;
    let fail1 = run_with_cache(&dir, true, &store)?;
    assert_eq!(fail1.exit_code, 1);
    assert_eq!(fail1.counts.cached, 0);
    let fail2 = run_with_cache(&dir, true, &store)?;
    assert_eq!(fail2.exit_code, 1);
    assert_eq!(fail2.counts.cached, 0);

    let custom = FileReceiptStore::in_directory(dir.join(".git/custom-receipts"));
    assert!(custom.lookup("00").is_none());

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

#[test]
fn shared_cache_dir_hits_across_separate_worktree_directories() -> Result<(), Box<dyn Error>> {
    let wt_a = temp_repo("shared-wt-a")?;
    let wt_b = temp_repo("shared-wt-b")?;
    let shared_cache =
        std::env::temp_dir().join(format!("dads-testing-shared-cache-{}", std::process::id()));
    let _ = fs::remove_dir_all(&shared_cache);

    let cmd = "printf x >> .git/ran.txt && printf 'shared-ok'";
    for dir in [&wt_a, &wt_b] {
        write_manifest(dir, cmd)?;
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
        )?;
    }

    let store_a = FileReceiptStore::for_cache_dir(&shared_cache);
    let r_a = run_with_cache(&wt_a, true, &store_a)?;
    assert_eq!(r_a.exit_code, 0);
    assert_eq!(r_a.counts.cached, 0);
    assert!(!r_a.tasks[0].cached);
    assert_eq!(fs::read_to_string(wt_a.join(".git/ran.txt"))?.len(), 1);

    let store_b = FileReceiptStore::for_cache_dir(&shared_cache);
    let r_b = run_with_cache(&wt_b, true, &store_b)?;
    assert_eq!(r_b.exit_code, 0);
    assert_eq!(r_b.counts.cached, 1);
    assert!(r_b.tasks[0].cached);
    assert_eq!(
        r_b.tasks[0].stdout.as_ref().map(|o| o.text.as_str()),
        Some("shared-ok")
    );
    assert!(!wt_b.join(".git/ran.txt").exists());

    let _ = fs::remove_dir_all(&wt_a);
    let _ = fs::remove_dir_all(&wt_b);
    let _ = fs::remove_dir_all(&shared_cache);
    Ok(())
}

#[test]
fn concurrent_writes_to_same_cache_key_never_corrupt_receipts() -> Result<(), Box<dyn Error>> {
    let shared_cache = std::env::temp_dir().join(format!(
        "dads-testing-concurrent-cache-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&shared_cache);
    let store = Arc::new(FileReceiptStore::for_cache_dir(&shared_cache));
    let key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    let mut handles = Vec::new();
    for worker in 0..8 {
        let store_ref = Arc::clone(&store);
        handles.push(thread::spawn(move || {
            for iter in 0..20 {
                let entry = TaskReceiptEntry {
                    stdout: Some(TaskOutput {
                        text: format!("worker-{worker}-iter-{iter}"),
                        truncated: false,
                    }),
                    stderr: None,
                };
                store_ref.record_pass(key, &entry);
                let found = store_ref.lookup(key);
                assert!(found.is_some(), "receipt must remain readable under races");
            }
        }));
    }
    for handle in handles {
        assert!(handle.join().is_ok());
    }

    let final_entry = store.lookup(key).ok_or("missing final receipt")?;
    assert!(
        final_entry
            .stdout
            .as_ref()
            .is_some_and(|out| out.text.starts_with("worker-"))
    );
    for entry in fs::read_dir(store.receipts_dir())? {
        let name = entry?.file_name();
        let name = name.to_string_lossy();
        assert!(
            !name.ends_with(".tmp"),
            "unexpected leftover temp file: {name}"
        );
    }

    let _ = fs::remove_dir_all(&shared_cache);
    Ok(())
}

#[test]
fn resolve_cache_dir_handles_absolute_relative_empty_and_tilde_paths() {
    let workspace = Path::new("/tmp/ws-root");
    assert_eq!(resolve_cache_dir("", workspace), None);
    assert_eq!(resolve_cache_dir("   ", workspace), None);
    assert_eq!(
        resolve_cache_dir("rel/cache", workspace),
        Some(PathBuf::from("/tmp/ws-root/rel/cache"))
    );
    assert_eq!(
        resolve_cache_dir("/var/tmp/shared-cache", workspace),
        Some(PathBuf::from("/var/tmp/shared-cache"))
    );
    if let Some(home) = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|value| !value.is_empty())
    {
        let home_path = PathBuf::from(home);
        assert_eq!(resolve_cache_dir("~", workspace), Some(home_path.clone()));
        assert_eq!(
            resolve_cache_dir("~/.cache/dad-test", workspace),
            Some(home_path.join(".cache/dad-test"))
        );
    }
}
