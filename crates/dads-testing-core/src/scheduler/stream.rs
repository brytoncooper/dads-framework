//! Live human-readable task progress written to stderr when `stream: true`.
//!
//! Stdout is strictly reserved for the protocol-v1 JSON envelope, so live progress lines always go
//! to stderr.

use crate::protocol::TaskRunResult;
use std::io::{self, Write};

pub(super) fn emit_cached(enabled: bool, task_id: &str) {
    if !enabled {
        return;
    }
    let _ = writeln!(io::stderr(), "[dad-test] cached {task_id}");
}

pub(super) fn emit_start(enabled: bool, task_ids: &[&str]) {
    if !enabled || task_ids.is_empty() {
        return;
    }
    if task_ids.len() == 1 {
        let _ = writeln!(io::stderr(), "[dad-test] start  {}", task_ids[0]);
    } else {
        let _ = writeln!(
            io::stderr(),
            "[dad-test] start  batch({} tasks: {} ..)",
            task_ids.len(),
            task_ids[0]
        );
    }
}

pub(super) fn emit_batch_fallback(enabled: bool, count: usize, first_id: &str) {
    if !enabled {
        return;
    }
    let _ = writeln!(
        io::stderr(),
        "[dad-test] retry  batch({count} tasks: {first_id} ..) failed; isolating individually"
    );
}

pub(super) fn emit_finish(enabled: bool, result: &TaskRunResult) {
    if !enabled {
        return;
    }
    let ms = result.duration_ms.unwrap_or(0);
    let mut stderr = io::stderr();
    if result.status == "executed" {
        let _ = writeln!(stderr, "[dad-test] pass   {} ({ms}ms)", result.id);
        return;
    }
    let code = result
        .exit_code
        .map_or_else(|| "error".to_owned(), |c| format!("exit {c}"));
    let _ = writeln!(stderr, "[dad-test] FAIL   {} ({ms}ms, {code})", result.id);
    if let Some(error) = result.error.as_deref() {
        let _ = writeln!(stderr, "  error: {error}");
    }
    if let Some(out) = result.stderr.as_ref().or(result.stdout.as_ref()) {
        let trimmed = out.text.trim();
        if !trimmed.is_empty() {
            for line in trimmed.lines().take(20) {
                let _ = writeln!(stderr, "  | {line}");
            }
        }
    }
}
