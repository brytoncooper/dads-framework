//! Every request `execute` refuses before it plans anything.
//!
//! Each case below leaves through the protocol as an `ok: false` response carrying the reason,
//! rather than as a panic or as a plan built from a request the engine cannot honor. The
//! workspace each request names holds no manifest, so a guard that stopped refusing would fail
//! later with a different message instead of silently answering.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::too_many_lines
)]

use dads_testing_core::{
    NativeRequest, NativeResponse, Operation, PROTOCOL_SCHEMA_VERSION, execute_request,
};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static WORKSPACE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn an_unsupported_request_schema_version_is_refused() {
    let workspace = TemporaryWorkspace::create();
    for version in [0, 2, 99] {
        let response = execute_request(NativeRequest {
            schema_version: version,
            ..plan_request(&workspace.0)
        });
        assert_refusal(
            &response,
            &format!("Unsupported request schemaVersion {version}. Expected 1."),
        );
    }
}

/// The pair is refused whether or not `--all` was also asked for: this guard runs first, so a
/// `--head` with neither a base nor a meaningful scope never reaches scope resolution.
#[test]
fn a_head_without_a_base_is_refused() {
    let workspace = TemporaryWorkspace::create();
    for all in [false, true] {
        let response = execute_request(NativeRequest {
            all,
            head: Some("HEAD".to_owned()),
            ..plan_request(&workspace.0)
        });
        assert_refusal(&response, "--head requires --base.");
    }
}

#[test]
fn all_combined_with_a_base_or_a_head_is_refused() {
    let workspace = TemporaryWorkspace::create();
    for (base, head) in [
        (Some("main".to_owned()), None),
        (Some("main".to_owned()), Some("HEAD".to_owned())),
    ] {
        let response = execute_request(NativeRequest {
            all: true,
            base,
            head,
            ..plan_request(&workspace.0)
        });
        assert_refusal(&response, "--all cannot be combined with --base or --head.");
    }
}

#[test]
fn all_combined_with_task_is_refused_and_only_requires_selector() {
    let workspace = TemporaryWorkspace::create();
    workspace.write_manifest();
    let all_with_task = execute_request(NativeRequest {
        all: true,
        task_ids: vec!["fixture:test".into()],
        ..plan_request(&workspace.0)
    });
    assert_refusal(
        &all_with_task,
        "--all cannot be combined with --task. Use --only --task <id> to run only the requested tasks and their prerequisites.",
    );

    let only_empty = execute_request(NativeRequest {
        only: true,
        ..plan_request(&workspace.0)
    });
    assert_refusal(
        &only_empty,
        "--only requires at least one --task, --project, --target, or --kind selector.",
    );

    let only_with_base = execute_request(NativeRequest {
        only: true,
        base: Some("HEAD".into()),
        task_ids: vec!["fixture:test".into()],
        ..plan_request(&workspace.0)
    });
    assert_refusal(
        &only_with_base,
        "--only cannot be combined with --all, --base, or --head.",
    );
}

/// The planner's own bound: `plan.rs` refuses a zero job limit, so a `run` never reaches the
/// scheduler with one. `src/tests/running.rs` holds the scheduler's matching refusal.
#[test]
fn a_zero_job_limit_is_refused_while_the_plan_is_built() {
    let workspace = TemporaryWorkspace::create();
    workspace.write_manifest();
    for operation in [Operation::Plan, Operation::Run] {
        let response = execute_request(NativeRequest {
            operation,
            all: true,
            jobs: Some(0),
            ..plan_request(&workspace.0)
        });
        assert_refusal(&response, "jobs must be greater than zero.");
    }
}

#[test]
fn a_positive_job_limit_is_accepted_by_the_same_plan() {
    let workspace = TemporaryWorkspace::create();
    workspace.write_manifest();
    let response = execute_request(NativeRequest {
        all: true,
        jobs: Some(1),
        ..plan_request(&workspace.0)
    });
    assert!(response.ok, "{response:?}");
}

fn assert_refusal(response: &NativeResponse, expected: &str) {
    assert!(!response.ok, "{response:?}");
    assert!(response.result.is_none(), "{response:?}");
    assert_eq!(response.error.as_deref(), Some(expected));
}

fn plan_request(workspace_root: &Path) -> NativeRequest {
    NativeRequest {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        operation: Operation::Plan,
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        manifest_path: None,
        base: None,
        head: None,
        all: false,
        task_ids: Vec::new(),
        task_kinds: Vec::new(),
        shard: None,
        jobs: None,
        cache: false,
        remote_cache_url: None,
        ..NativeRequest::default()
    }
}

struct TemporaryWorkspace(PathBuf);

impl TemporaryWorkspace {
    fn create() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock must be after the epoch")
            .as_nanos();
        let sequence = WORKSPACE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "dads-request-refusals-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("temporary workspace must be creatable");
        Self(path)
    }

    fn write_manifest(&self) {
        let manifest = json!({
            "schemaVersion": 1,
            "workspace": {"root": ".", "fullFallback": {"taskIds": ["fixture:test"]}},
            "projects": [{"id": "fixture", "root": ".", "fallbackDependencies": []}],
            "tasks": [{
                "id": "fixture:test",
                "project": "fixture",
                "kind": "test",
                "execution": {"executable": "true"},
                "dependsOn": [],
                "impact": {"mode": "always"},
            }],
        });
        fs::write(self.0.join("dads.testing.json"), manifest.to_string())
            .expect("manifest must be writable");
    }
}

impl Drop for TemporaryWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
