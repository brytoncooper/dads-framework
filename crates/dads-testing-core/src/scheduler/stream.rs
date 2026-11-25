//! Live human-readable task progress written to stderr when `stream: true`.
//!
//! Stdout is strictly reserved for the protocol-v1 JSON envelope, so live progress lines always go
//! to stderr.

use crate::protocol::TaskRunResult;
use std::io::{self, Write};

const FAILED_STDOUT_TAIL_LINES: usize = 30;
const FAILED_STDERR_TAIL_LINES: usize = 20;

pub(super) fn emit_cached(enabled: bool, task_id: &str) {
    if !enabled {
        return;
    }
    let _ = writeln!(io::stderr(), "[dad-test] CACHED {task_id}");
}

pub(super) fn emit_start(enabled: bool, task_ids: &[&str]) {
    if !enabled || task_ids.is_empty() {
        return;
    }
    if task_ids.len() == 1 {
        let _ = writeln!(io::stderr(), "[dad-test] START  {}", task_ids[0]);
    } else {
        let _ = writeln!(
            io::stderr(),
            "[dad-test] START  batch({} tasks: {} ..)",
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
        "[dad-test] RETRY  batch({count} tasks: {first_id} ..) failed; isolating individually"
    );
}

pub(super) fn emit_finish(enabled: bool, result: &TaskRunResult) {
    if !enabled {
        return;
    }
    let mut stderr = io::stderr();
    write_finish(&mut stderr, result);
}

pub(crate) fn write_finish(out: &mut impl Write, result: &TaskRunResult) {
    let ms = result.duration_ms.unwrap_or(0);
    if result.status == "executed" {
        let _ = writeln!(out, "[dad-test] PASS   {} ({ms}ms)", result.id);
        return;
    }
    let code = result
        .exit_code
        .map_or_else(|| "error".to_owned(), |c| format!("exit {c}"));
    let _ = writeln!(out, "[dad-test] FAIL   {} ({ms}ms, {code})", result.id);
    if let Some(error) = result.error.as_deref() {
        let _ = writeln!(out, "  error: {error}");
    }
    if let Some(stdout) = result.stdout.as_ref() {
        write_tail_section(out, "stdout", &stdout.text, FAILED_STDOUT_TAIL_LINES);
    }
    if let Some(stderr) = result.stderr.as_ref() {
        write_tail_section(out, "stderr", &stderr.text, FAILED_STDERR_TAIL_LINES);
    }
}

fn write_tail_section(out: &mut impl Write, label: &str, text: &str, max_lines: usize) {
    let non_empty: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if non_empty.is_empty() {
        return;
    }
    let start = non_empty.len().saturating_sub(max_lines);
    let _ = writeln!(out, "  [{label}]");
    for line in &non_empty[start..] {
        let _ = writeln!(out, "  | {line}");
    }
}
