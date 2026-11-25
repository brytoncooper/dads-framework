//! Vitest narrowed-file batching: executes compatible narrowed Vitest tasks in a single process
//! with `--reporter=json --outputFile=<tmp>` and attributes per-file pass/fail and duration back
//! to each individual task. Fails closed whenever the JSON report is missing, corrupt, or reports
//! an unattributed global failure.

use super::progress::rebase_file_for_cwd;
use super::worker::execute_task;
use crate::manifest::TaskExecution;
use crate::protocol::{TaskOutput, TaskRunResult};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static REPORT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(super) struct VitestBatchMember {
    pub(super) index: usize,
    pub(super) id: String,
    pub(super) selected_files: Vec<String>,
}

struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VitestJsonReport {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    test_results: Vec<VitestFileResult>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VitestFileResult {
    name: String,
    status: String,
    #[serde(default)]
    start_time: f64,
    #[serde(default)]
    end_time: f64,
    #[serde(default)]
    message: String,
    #[serde(default)]
    assertion_results: Vec<VitestAssertionResult>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VitestAssertionResult {
    #[serde(default)]
    full_name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    failure_messages: Vec<String>,
}

struct FileOutcome {
    passed: bool,
    duration_ms: u64,
    failure_lines: Vec<String>,
}

/// Runs a single batched Vitest invocation for `members` and returns one attributed `TaskRunResult`
/// per member in `members` order.
pub(super) fn execute_vitest_batch(
    worker_id: usize,
    mut execution: TaskExecution,
    members: Vec<VitestBatchMember>,
    workspace_root: PathBuf,
) -> Vec<(usize, TaskRunResult)> {
    let seq = REPORT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let report_path = std::env::temp_dir().join(format!(
        "dads-vitest-batch-{}-{worker_id}-{seq}.json",
        std::process::id()
    ));
    let _guard = TempFileGuard(report_path.clone());

    let batch_cwd = execution.cwd.clone();
    append_vitest_batch_args(&mut execution, &members, &report_path);

    let first_id = members
        .first()
        .map_or_else(|| "vitest-batch".to_owned(), |m| m.id.clone());
    let batch_result = execute_task(first_id, execution, workspace_root.clone());

    attribute_from_report_file(
        &report_path,
        &members,
        &batch_result,
        &workspace_root,
        batch_cwd.as_deref(),
    )
}

fn append_vitest_batch_args(
    execution: &mut TaskExecution,
    members: &[VitestBatchMember],
    report_path: &Path,
) {
    let has_reporter = execution
        .args
        .iter()
        .any(|arg| arg == "--reporter" || arg.starts_with("--reporter="));
    let has_json_reporter = execution.args.iter().any(|arg| arg == "--reporter=json");
    if !has_reporter {
        execution.args.push("--reporter=default".to_owned());
    }
    if !has_json_reporter {
        execution.args.push("--reporter=json".to_owned());
    }
    execution
        .args
        .push(format!("--outputFile={}", report_path.display()));

    let mut seen = BTreeSet::new();
    for member in members {
        for file in &member.selected_files {
            if seen.insert(file.as_str()) {
                execution
                    .args
                    .push(rebase_file_for_cwd(file, execution.cwd.as_deref()));
            }
        }
    }
}

fn attribute_from_report_file(
    report_path: &Path,
    members: &[VitestBatchMember],
    batch_result: &TaskRunResult,
    workspace_root: &Path,
    batch_cwd: Option<&str>,
) -> Vec<(usize, TaskRunResult)> {
    let raw_json = match fs::read_to_string(report_path) {
        Ok(text) => text,
        Err(error) => {
            return fail_all_members(
                members,
                batch_result,
                format!("Vitest batch did not produce a JSON report: {error}"),
            );
        }
    };
    let report: VitestJsonReport = match serde_json::from_str(&raw_json) {
        Ok(parsed) => parsed,
        Err(error) => {
            return fail_all_members(
                members,
                batch_result,
                format!("Vitest batch produced an invalid JSON report: {error}"),
            );
        }
    };
    attribute_report(&report, members, batch_result, workspace_root, batch_cwd)
}

fn attribute_report(
    report: &VitestJsonReport,
    members: &[VitestBatchMember],
    batch_result: &TaskRunResult,
    workspace_root: &Path,
    batch_cwd: Option<&str>,
) -> Vec<(usize, TaskRunResult)> {
    let outcomes = index_file_outcomes(report, workspace_root, batch_cwd);
    let batch_clean = report.success && batch_result.exit_code == Some(0);
    let mut attributed = Vec::with_capacity(members.len());
    let mut any_member_failed = false;

    for member in members {
        let (result, failed) = attribute_member(member, &outcomes, batch_result, batch_clean);
        any_member_failed |= failed;
        attributed.push((member.index, result));
    }

    // Fail-closed: if Vitest exited non-zero or reported `success: false`, yet every member's files
    // appeared to pass, an unattributed global failure occurred (e.g. unhandled error or teardown).
    if !batch_clean && !any_member_failed {
        return fail_all_members(
            members,
            batch_result,
            "Vitest batch exited non-zero without a failing test file in the JSON report."
                .to_owned(),
        );
    }

    attributed
}

fn index_file_outcomes(
    report: &VitestJsonReport,
    workspace_root: &Path,
    batch_cwd: Option<&str>,
) -> BTreeMap<String, FileOutcome> {
    let canonical_root = fs::canonicalize(workspace_root).ok();
    let mut outcomes: BTreeMap<String, FileOutcome> = BTreeMap::new();
    for file_result in &report.test_results {
        let Some(key) = normalize_report_path(
            &file_result.name,
            workspace_root,
            canonical_root.as_deref(),
            batch_cwd,
        ) else {
            continue;
        };
        let has_failed_assertion = file_result
            .assertion_results
            .iter()
            .any(|a| a.status == "failed");
        let passed = file_result.status == "passed" && !has_failed_assertion;
        let duration_ms = duration_from_timestamps(file_result.start_time, file_result.end_time);
        let failure_lines = collect_failure_lines(&key, file_result);
        outcomes
            .entry(key)
            .and_modify(|existing| {
                existing.passed = existing.passed && passed;
                existing.duration_ms = existing.duration_ms.saturating_add(duration_ms);
                existing.failure_lines.extend(failure_lines.iter().cloned());
            })
            .or_insert(FileOutcome {
                passed,
                duration_ms,
                failure_lines,
            });
    }
    outcomes
}

fn attribute_member(
    member: &VitestBatchMember,
    outcomes: &BTreeMap<String, FileOutcome>,
    batch_result: &TaskRunResult,
    batch_clean: bool,
) -> (TaskRunResult, bool) {
    let mut missing_files = Vec::new();
    let mut failure_lines = Vec::new();
    let mut total_duration_ms: u64 = 0;
    let mut all_passed = !member.selected_files.is_empty();

    for file in &member.selected_files {
        let normalized = normalize_relative_str(file);
        match outcomes.get(&normalized) {
            Some(outcome) => {
                total_duration_ms = total_duration_ms.saturating_add(outcome.duration_ms);
                if !outcome.passed {
                    all_passed = false;
                    failure_lines.extend(outcome.failure_lines.iter().cloned());
                }
            }
            None => {
                all_passed = false;
                missing_files.push(normalized);
            }
        }
    }

    if all_passed {
        return (
            TaskRunResult {
                id: member.id.clone(),
                status: "executed".into(),
                exit_code: Some(0),
                duration_ms: Some(total_duration_ms),
                stdout: if batch_clean {
                    batch_result.stdout.clone()
                } else {
                    None
                },
                stderr: if batch_clean {
                    batch_result.stderr.clone()
                } else {
                    None
                },
                error: None,
                cached: false,
            },
            false,
        );
    }

    let error = if !missing_files.is_empty() {
        Some(format!(
            "Vitest batch did not report execution for: {}",
            missing_files.join(", ")
        ))
    } else {
        None
    };
    let stderr = if !failure_lines.is_empty() {
        Some(TaskOutput {
            text: failure_lines.join("\n"),
            truncated: false,
        })
    } else {
        batch_result.stderr.clone()
    };
    (
        TaskRunResult {
            id: member.id.clone(),
            status: "failed".into(),
            exit_code: batch_result.exit_code.filter(|&code| code != 0).or(Some(1)),
            duration_ms: Some(total_duration_ms),
            stdout: batch_result.stdout.clone(),
            stderr,
            error,
            cached: false,
        },
        true,
    )
}

fn fail_all_members(
    members: &[VitestBatchMember],
    batch_result: &TaskRunResult,
    error: String,
) -> Vec<(usize, TaskRunResult)> {
    let exit_code = batch_result.exit_code.filter(|&code| code != 0).or(Some(1));
    members
        .iter()
        .map(|member| {
            (
                member.index,
                TaskRunResult {
                    id: member.id.clone(),
                    status: "failed".into(),
                    exit_code,
                    duration_ms: batch_result.duration_ms,
                    stdout: batch_result.stdout.clone(),
                    stderr: batch_result.stderr.clone(),
                    error: Some(error.clone()),
                    cached: false,
                },
            )
        })
        .collect()
}

fn collect_failure_lines(file_path: &str, file_result: &VitestFileResult) -> Vec<String> {
    let mut lines = Vec::new();
    let trimmed_message = file_result.message.trim();
    if !trimmed_message.is_empty() {
        lines.push(format!("{file_path}: {trimmed_message}"));
    }
    for assertion in &file_result.assertion_results {
        if assertion.status != "failed" {
            continue;
        }
        if assertion.failure_messages.is_empty() {
            lines.push(format!("FAIL {file_path} > {}", assertion.full_name));
        } else {
            for message in &assertion.failure_messages {
                lines.push(format!(
                    "FAIL {file_path} > {}: {}",
                    assertion.full_name,
                    message.trim()
                ));
            }
        }
    }
    lines
}

fn normalize_report_path(
    raw: &str,
    workspace_root: &Path,
    canonical_root: Option<&Path>,
    batch_cwd: Option<&str>,
) -> Option<String> {
    let candidate = Path::new(raw);
    if candidate.is_absolute() {
        if let Ok(rel) = candidate.strip_prefix(workspace_root) {
            return Some(path_to_forward_slashes(rel));
        }
        if let Some(canon_root) = canonical_root {
            if let Ok(rel) = candidate.strip_prefix(canon_root) {
                return Some(path_to_forward_slashes(rel));
            }
            if let Ok(canon_file) = fs::canonicalize(candidate)
                && let Ok(rel) = canon_file.strip_prefix(canon_root)
            {
                return Some(path_to_forward_slashes(rel));
            }
        }
        return None;
    }
    let normalized = normalize_relative_str(raw);
    if let Some(cwd) = batch_cwd {
        let trimmed = cwd.trim_end_matches('/');
        if !trimmed.is_empty()
            && trimmed != "."
            && !workspace_root.join(&normalized).exists()
            && !normalized.starts_with(&format!("{trimmed}/"))
        {
            return Some(format!("{trimmed}/{normalized}"));
        }
    }
    Some(normalized)
}

fn normalize_relative_str(raw: &str) -> String {
    let replaced = raw.replace('\\', "/");
    replaced.strip_prefix("./").unwrap_or(&replaced).to_owned()
}

fn path_to_forward_slashes(path: &Path) -> String {
    normalize_relative_str(&path.to_string_lossy())
}

fn duration_from_timestamps(start_ms: f64, end_ms: f64) -> u64 {
    if !start_ms.is_finite() || !end_ms.is_finite() {
        return 0;
    }
    let diff = (end_ms - start_ms).max(0.0).round();
    if diff >= u64::MAX as f64 {
        u64::MAX
    } else {
        diff as u64
    }
}
