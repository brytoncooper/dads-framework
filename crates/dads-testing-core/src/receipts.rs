//! Content-hashed task receipt boundary.
//!
//! Receipts are strictly opt-in (`--cache`). The core defines the trait and input description so
//! it stays free of hashing and filesystem persistence crates; `dads-testing-store` provides the
//! SHA-256 atomic file store under Git metadata.

use crate::protocol::TaskOutput;
use std::path::Path;

pub struct TaskReceiptRequest<'a> {
    pub task_id: &'a str,
    pub project: &'a str,
    pub executable: &'a str,
    pub args: &'a [String],
    pub cwd: Option<&'a str>,
    pub shell: bool,
    pub setup_files: &'a [String],
    pub selected_files: &'a [String],
    pub project_roots: &'a [String],
    pub manifest_path: &'a Path,
    pub workspace_root: &'a Path,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskReceiptEntry {
    pub stdout: Option<TaskOutput>,
    pub stderr: Option<TaskOutput>,
}

pub trait TaskReceiptStore: Sync {
    /// Computes the exact content-addressed key for this task invocation, or `None` when inputs
    /// cannot be hashed safely (fail-closed: caller executes without caching).
    fn compute_key(&self, request: &TaskReceiptRequest<'_>) -> Option<String>;
    /// Looks up a previously verified passing receipt for `key`.
    fn lookup(&self, key: &str) -> Option<TaskReceiptEntry>;
    /// Atomically persists a verified passing receipt for `key`.
    fn record_pass(&self, key: &str, entry: &TaskReceiptEntry);
}
