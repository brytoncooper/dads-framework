//! End-to-end binary tests for shared local disk cache (`cacheDir` and `DAD_TEST_CACHE_DIR`).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::too_many_lines
)]

#[allow(dead_code)]
mod workspace;

use serde_json::{Value, json};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use workspace::TemporaryWorkspace;

fn run_manifest() -> Value {
    json!({
        "schemaVersion": 1,
        "workspace": {
            "root": ".",
            "fullFallback": { "taskIds": ["app:test"] }
        },
        "projects": [
            { "id": "app", "root": "app", "fallbackDependencies": [] }
        ],
        "tasks": [
            {
                "id": "app:test",
                "project": "app",
                "kind": "test",
                "execution": {
                    "executable": "sh",
                    "args": ["-c", "printf ran >> .git/marker.txt && printf 'cached-output'"]
                },
                "dependsOn": [],
                "impact": { "mode": "project", "paths": [] }
            }
        ]
    })
}

fn temp_cache_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "dad-test-cache-{label}-{}-{nanos}",
        std::process::id()
    ))
}

fn run_native_cli(
    workspace_root: &Path,
    cache_dir: Option<&Path>,
    env_cache_dir: Option<&Path>,
) -> Value {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_dad-test"));
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_remove("DAD_TEST_CACHE_DIR");
    if let Some(env_dir) = env_cache_dir {
        cmd.env("DAD_TEST_CACHE_DIR", env_dir);
    }
    let mut child = cmd.spawn().expect("dad-test must start");
    let mut request = json!({
        "schemaVersion": 1,
        "operation": "run",
        "workspaceRoot": workspace_root.to_string_lossy(),
        "only": true,
        "taskIds": ["app:test"],
        "jobs": 1,
        "cache": true
    });
    if let Some(dir) = cache_dir {
        request["cacheDir"] = json!(dir.to_string_lossy());
    }
    child
        .stdin
        .as_mut()
        .expect("stdin piped")
        .write_all(request.to_string().as_bytes())
        .expect("request writable");
    let output = child.wait_with_output().expect("dad-test must finish");
    let response: Value =
        serde_json::from_slice(&output.stdout).expect("dad-test must emit valid JSON");
    assert_eq!(response["ok"], true, "{response}");
    response["result"]["run"].clone()
}

#[test]
fn cache_dir_and_env_var_share_receipts_across_workspaces_with_flag_precedence() {
    let manifest = run_manifest();
    let wt_a = TemporaryWorkspace::create("shared-cache-a", &manifest);
    let wt_b = TemporaryWorkspace::create("shared-cache-b", &manifest);
    let wt_c = TemporaryWorkspace::create("shared-cache-c", &manifest);

    let env_cache = temp_cache_dir("env");
    let flag_cache = temp_cache_dir("flag");

    // 1. Populate via DAD_TEST_CACHE_DIR in wt_a
    let run_a = run_native_cli(&wt_a.0, None, Some(&env_cache));
    assert_eq!(run_a["exitCode"], 0);
    assert_eq!(run_a["tasks"][0]["cached"], Value::Null);
    assert!(wt_a.0.join(".git/marker.txt").exists());

    // 2. Second workspace wt_b with same DAD_TEST_CACHE_DIR gets 100% cache hit
    let run_b = run_native_cli(&wt_b.0, None, Some(&env_cache));
    assert_eq!(run_b["exitCode"], 0);
    assert_eq!(run_b["counts"]["cached"], 1);
    assert_eq!(run_b["tasks"][0]["cached"], true);
    assert_eq!(run_b["tasks"][0]["stdout"]["text"], "cached-output");
    assert!(!wt_b.0.join(".git/marker.txt").exists());

    // 3. Explicit cacheDir overrides DAD_TEST_CACHE_DIR (misses empty flag_cache instead of hitting env_cache)
    let run_c_miss = run_native_cli(&wt_c.0, Some(&flag_cache), Some(&env_cache));
    assert_eq!(run_c_miss["exitCode"], 0);
    assert_eq!(run_c_miss["tasks"][0]["cached"], Value::Null);
    assert!(wt_c.0.join(".git/marker.txt").exists());

    // 4. Subsequent run in wt_b with explicit cacheDir hits flag_cache
    let run_b_flag_hit = run_native_cli(&wt_b.0, Some(&flag_cache), Some(&env_cache));
    assert_eq!(run_b_flag_hit["exitCode"], 0);
    assert_eq!(run_b_flag_hit["counts"]["cached"], 1);
    assert_eq!(run_b_flag_hit["tasks"][0]["cached"], true);
    assert!(!wt_b.0.join(".git/marker.txt").exists());

    let _ = fs::remove_dir_all(&env_cache);
    let _ = fs::remove_dir_all(&flag_cache);
}
