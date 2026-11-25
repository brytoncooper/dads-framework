//! Vitest JSON reporter schema, failure line extraction, and path/timestamp normalization,
//! split from `vitest_batch.rs` to keep each scheduler module focused and under budget.

use serde::Deserialize;
use std::fs;
use std::path::Path;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VitestJsonReport {
    #[serde(default)]
    pub(super) success: bool,
    #[serde(default)]
    pub(super) test_results: Vec<VitestFileResult>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VitestFileResult {
    pub(super) name: String,
    pub(super) status: String,
    #[serde(default)]
    pub(super) start_time: f64,
    #[serde(default)]
    pub(super) end_time: f64,
    #[serde(default)]
    pub(super) message: String,
    #[serde(default)]
    pub(super) assertion_results: Vec<VitestAssertionResult>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VitestAssertionResult {
    #[serde(default)]
    pub(super) full_name: String,
    #[serde(default)]
    pub(super) status: String,
    #[serde(default)]
    pub(super) failure_messages: Vec<String>,
}

pub(super) struct FileOutcome {
    pub(super) passed: bool,
    pub(super) duration_ms: u64,
    pub(super) failure_lines: Vec<String>,
}

pub(super) fn collect_failure_lines(
    file_path: &str,
    file_result: &VitestFileResult,
) -> Vec<String> {
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

pub(super) fn normalize_report_path(
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

pub(super) fn normalize_relative_str(raw: &str) -> String {
    let replaced = raw.replace('\\', "/");
    replaced.strip_prefix("./").unwrap_or(&replaced).to_owned()
}

fn path_to_forward_slashes(path: &Path) -> String {
    normalize_relative_str(&path.to_string_lossy())
}

pub(super) fn duration_from_timestamps(start_ms: f64, end_ms: f64) -> u64 {
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
