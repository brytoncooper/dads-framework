use crate::receipts::FileReceiptStore;
use dads_testing_core::{
    NativeRequest, Operation, PROTOCOL_SCHEMA_VERSION, RunResult,
    execute_request_with_graph_and_receipts,
};
use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;

fn git(dir: &Path, args: &[&str]) -> Result<(), Box<dyn Error>> {
    let status = Command::new("git").args(args).current_dir(dir).status()?;
    assert!(status.success(), "git {args:?} failed");
    Ok(())
}

fn make_repo(name: &str, env_tier: &str, command: &str) -> Result<PathBuf, Box<dyn Error>> {
    let dir =
        std::env::temp_dir().join(format!("dads-testing-remote-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("src"))?;
    git(&dir, &["init", "-q"])?;
    fs::write(dir.join("src/a.ts"), "export const v = 1;\n")?;
    write_manifest_with_env(&dir, env_tier, command)?;
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
    Ok(dir)
}

fn write_manifest_with_env(
    dir: &Path,
    env_tier: &str,
    command: &str,
) -> Result<(), Box<dyn Error>> {
    let manifest = serde_json::json!({
        "schemaVersion": 1,
        "workspace": { "root": ".", "fullFallback": { "taskIds": ["app:test"] } },
        "projects": [{ "id": "app", "root": "src", "fallbackDependencies": [] }],
        "tasks": [{
            "id": "app:test",
            "project": "app",
            "kind": "test",
            "execution": {
                "executable": "sh",
                "args": ["-c", command],
                "env": { "VITEST_TIER": env_tier }
            },
            "dependsOn": [],
            "impact": { "mode": "always", "paths": [] }
        }]
    });
    fs::write(
        dir.join("dads.testing.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    Ok(())
}

fn run_task(dir: &Path, store: &FileReceiptStore) -> Result<RunResult, Box<dyn Error>> {
    let req = NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Run,
        workspace_root: dir.display().to_string(),
        manifest_path: None,
        base: None,
        head: None,
        all: true,
        task_ids: Vec::new(),
        jobs: Some(1),
        cache: true,
        remote_cache_url: None,
    };
    let resp = execute_request_with_graph_and_receipts(req, None, Some(store));
    assert!(resp.ok, "{resp:?}");
    resp.result
        .and_then(|r| r.run)
        .ok_or_else(|| "missing run result".into())
}

type BlobStore = Arc<Mutex<BTreeMap<String, Vec<u8>>>>;

fn start_mock_http_cache() -> Result<(String, BlobStore), Box<dyn Error>> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let blobs = Arc::new(Mutex::new(BTreeMap::<String, Vec<u8>>::new()));
    let server_blobs = Arc::clone(&blobs);

    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            handle_http_connection(stream, &server_blobs);
        }
    });

    Ok((format!("http://127.0.0.1:{port}/cache"), blobs))
}

fn handle_http_connection(mut stream: std::net::TcpStream, blobs: &BlobStore) {
    let mut buf = Vec::new();
    let mut tmp = [0_u8; 4096];
    let header_end;
    loop {
        let Ok(n) = stream.read(&mut tmp) else {
            return;
        };
        if n == 0 {
            return;
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = pos;
            break;
        }
    }
    let header = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let mut parts = header.lines().next().unwrap_or_default().split_whitespace();
    let method = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default().to_owned();
    let content_len: usize = header
        .lines()
        .find_map(|line| {
            let lower = line.to_ascii_lowercase();
            lower
                .strip_prefix("content-length:")
                .and_then(|v| v.trim().parse().ok())
        })
        .unwrap_or(0);
    while buf.len() < header_end + 4 + content_len {
        let Ok(n) = stream.read(&mut tmp) else {
            return;
        };
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    let body = buf[header_end + 4..].to_vec();

    match method {
        "GET" => {
            let found = blobs
                .lock()
                .ok()
                .and_then(|guard| guard.get(&path).cloned());
            if let Some(data) = found {
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    data.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&data);
            } else {
                let _ = stream.write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
        }
        "PUT" => {
            if let Ok(mut guard) = blobs.lock() {
                guard.insert(path, body);
            }
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
        _ => {
            let _ = stream.write_all(
                b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
        }
    }
}

#[test]
fn env_changes_deliver_values_and_invalidate_l1_and_l2_http_receipts() -> Result<(), Box<dyn Error>>
{
    let (remote_url, blobs) = start_mock_http_cache()?;
    let dir = make_repo("http-env", "unit", "printf '%s' \"$VITEST_TIER\"")?;

    // Worker 1 (PR CI): cold L1 + cold L2 -> executes and uploads passing receipt to L2.
    let worker1 = FileReceiptStore::in_directory(dir.join(".git/l1-worker1"))
        .with_remote_url(&remote_url, None);
    let r1 = run_task(&dir, &worker1)?;
    assert_eq!(r1.exit_code, 0);
    assert_eq!(r1.counts.cached, 0);
    assert_eq!(
        r1.tasks[0].stdout.as_ref().map(|o| o.text.as_str()),
        Some("unit")
    );
    assert_eq!(blobs.lock().map_err(|_| "poison")?.len(), 1);

    // Worker 2 (Merge Queue): empty L1, same L2 -> hits L2 and hydrates its own L1!
    let worker2 = FileReceiptStore::in_directory(dir.join(".git/l1-worker2"))
        .with_remote_url(&remote_url, None);
    let r2 = run_task(&dir, &worker2)?;
    assert_eq!(r2.exit_code, 0);
    assert_eq!(r2.counts.cached, 1);
    assert!(r2.tasks[0].cached);
    assert_eq!(
        r2.tasks[0].stdout.as_ref().map(|o| o.text.as_str()),
        Some("unit")
    );

    // Changing task env (`unit` -> `integration`) MUST miss L1 & L2 and run with new env!
    write_manifest_with_env(&dir, "integration", "printf '%s' \"$VITEST_TIER\"")?;
    let r3 = run_task(&dir, &worker2)?;
    assert_eq!(r3.exit_code, 0);
    assert_eq!(r3.counts.cached, 0);
    assert_eq!(
        r3.tasks[0].stdout.as_ref().map(|o| o.text.as_str()),
        Some("integration")
    );
    assert_eq!(blobs.lock().map_err(|_| "poison")?.len(), 2);

    // Corrupting every L2 blob forces a fresh worker to fail closed and re-execute!
    for value in blobs.lock().map_err(|_| "poison")?.values_mut() {
        *value = b"{corrupt-l2".to_vec();
    }
    let worker3 = FileReceiptStore::in_directory(dir.join(".git/l1-worker3"))
        .with_remote_url(&remote_url, None);
    let r4 = run_task(&dir, &worker3)?;
    assert_eq!(r4.exit_code, 0);
    assert_eq!(r4.counts.cached, 0);

    // Failing runs NEVER upload to L2!
    let count_before_fail = blobs.lock().map_err(|_| "poison")?.len();
    write_manifest_with_env(&dir, "integration", "exit 1")?;
    let fail = run_task(&dir, &worker3)?;
    assert_eq!(fail.exit_code, 1);
    assert_eq!(fail.counts.cached, 0);
    assert_eq!(blobs.lock().map_err(|_| "poison")?.len(), count_before_fail);

    // Unreachable L2 fails closed without erroring the run.
    write_manifest_with_env(&dir, "offline", "printf 'ok'")?;
    let offline_worker = FileReceiptStore::in_directory(dir.join(".git/l1-offline"))
        .with_remote_url("http://127.0.0.1:1/unreachable", None);
    let r_offline = run_task(&dir, &offline_worker)?;
    assert_eq!(r_offline.exit_code, 0);
    assert_eq!(r_offline.counts.cached, 0);

    let _ = fs::remove_dir_all(&dir);
    Ok(())
}
