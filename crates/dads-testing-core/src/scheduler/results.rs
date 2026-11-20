//! The shapes one task's outcome can take. Every terminal status a run reports is built here, so
//! the status strings and the explanations that go with them stay in one place.
use super::TaskStatus;
use crate::protocol::{TaskOutput, TaskRunResult};
use std::collections::BTreeMap;

pub(super) fn not_applicable_result(id: &str) -> TaskRunResult {
    TaskRunResult {
        id: id.into(),
        status: "not-applicable".into(),
        exit_code: None,
        duration_ms: None,
        stdout: None,
        stderr: None,
        error: None,
    }
}

pub(super) fn blocked_result(
    id: &str,
    dependencies: &[String],
    statuses: &BTreeMap<String, TaskStatus>,
) -> TaskRunResult {
    let failed_dependencies = dependencies
        .iter()
        .filter(|dependency| {
            matches!(
                statuses.get(dependency.as_str()),
                Some(TaskStatus::Failed | TaskStatus::Blocked | TaskStatus::NotApplicable) | None
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    TaskRunResult {
        id: id.into(),
        status: "blocked".into(),
        exit_code: None,
        duration_ms: None,
        stdout: None,
        stderr: None,
        error: Some(format!(
            "Blocked by prerequisite{}: {}.",
            if failed_dependencies.len() == 1 {
                ""
            } else {
                "s"
            },
            failed_dependencies.join(", ")
        )),
    }
}

pub(super) fn worker_panic_result(id: &str) -> TaskRunResult {
    TaskRunResult {
        id: id.into(),
        status: "failed".into(),
        exit_code: None,
        duration_ms: None,
        stdout: None,
        stderr: None,
        error: Some("Task worker panicked before reporting a result.".into()),
    }
}

pub(super) fn completed_task_result(
    id: String,
    exit_code: Option<i32>,
    duration_ms: u64,
    stdout: Option<TaskOutput>,
    stderr: Option<TaskOutput>,
) -> TaskRunResult {
    match exit_code {
        Some(0) => TaskRunResult {
            id,
            status: "executed".into(),
            exit_code: Some(0),
            duration_ms: Some(duration_ms),
            stdout,
            stderr,
            error: None,
        },
        Some(exit_code) => TaskRunResult {
            id,
            status: "failed".into(),
            exit_code: Some(exit_code),
            duration_ms: Some(duration_ms),
            stdout,
            stderr,
            error: None,
        },
        None => TaskRunResult {
            id,
            status: "failed".into(),
            exit_code: None,
            duration_ms: Some(duration_ms),
            stdout,
            stderr,
            error: Some("Task ended without an exit code.".into()),
        },
    }
}

pub(super) fn task_error_result(
    id: String,
    started_at: std::time::Instant,
    error: String,
) -> TaskRunResult {
    let duration_ms = u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
    TaskRunResult {
        id,
        status: "failed".into(),
        exit_code: None,
        duration_ms: Some(duration_ms),
        stdout: None,
        stderr: None,
        error: Some(error),
    }
}
