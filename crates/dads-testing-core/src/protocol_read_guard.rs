//! Protocol-v1 runtime read-guard wire types, split from `protocol.rs` to keep each file focused.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Planner-computed workspace allowlist for one guarded test task's runtime file-read guard.
///
/// Serialized on runnable guarded `TaskDecision`s when read enforcement is active so
/// `dad-test run --plan-file` enforces the exact same allowlist as `--all` / `--base --head`
/// without re-parsing the workspace dependency graph.
#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskReadGuardAllowlist {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_project_roots: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_impact_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_extra_files: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_ancestor_dirs: Vec<String>,
}

impl TaskReadGuardAllowlist {
    /// Unions multiple task allowlists (used when a Vitest batch executes tasks together in
    /// enforce mode; any violation triggers isolated per-task re-execution for exact attribution).
    pub(crate) fn merge_many<'a>(lists: impl IntoIterator<Item = &'a Self>) -> Self {
        let mut project_roots = BTreeSet::new();
        let mut impact_paths = BTreeSet::new();
        let mut extra_files = BTreeSet::new();
        let mut ancestor_dirs = BTreeSet::new();
        for list in lists {
            project_roots.extend(list.allowed_project_roots.iter().cloned());
            impact_paths.extend(list.allowed_impact_paths.iter().cloned());
            extra_files.extend(list.allowed_extra_files.iter().cloned());
            ancestor_dirs.extend(list.allowed_ancestor_dirs.iter().cloned());
        }
        Self {
            allowed_project_roots: project_roots.into_iter().collect(),
            allowed_impact_paths: impact_paths.into_iter().collect(),
            allowed_extra_files: extra_files.into_iter().collect(),
            allowed_ancestor_dirs: ancestor_dirs.into_iter().collect(),
        }
    }

    /// Intersects multiple per-file allowlists to form the sound lower bound A_common used by
    /// Pass 1 of per-file read-guard auditing.
    pub(crate) fn intersect_many<'a>(lists: impl IntoIterator<Item = &'a Self>) -> Self {
        let mut iter = lists.into_iter();
        let Some(first) = iter.next() else {
            return Self::default();
        };
        let mut project_roots: BTreeSet<String> =
            first.allowed_project_roots.iter().cloned().collect();
        let mut impact_paths: BTreeSet<String> =
            first.allowed_impact_paths.iter().cloned().collect();
        let mut extra_files: BTreeSet<String> = first.allowed_extra_files.iter().cloned().collect();
        let mut ancestor_dirs: BTreeSet<String> =
            first.allowed_ancestor_dirs.iter().cloned().collect();
        for list in iter {
            let pr: BTreeSet<&str> = list
                .allowed_project_roots
                .iter()
                .map(String::as_str)
                .collect();
            let ip: BTreeSet<&str> = list
                .allowed_impact_paths
                .iter()
                .map(String::as_str)
                .collect();
            let ef: BTreeSet<&str> = list
                .allowed_extra_files
                .iter()
                .map(String::as_str)
                .collect();
            let ad: BTreeSet<&str> = list
                .allowed_ancestor_dirs
                .iter()
                .map(String::as_str)
                .collect();
            project_roots.retain(|item| pr.contains(item.as_str()));
            impact_paths.retain(|item| ip.contains(item.as_str()));
            extra_files.retain(|item| ef.contains(item.as_str()));
            ancestor_dirs.retain(|item| ad.contains(item.as_str()));
        }
        Self {
            allowed_project_roots: project_roots.into_iter().collect(),
            allowed_impact_paths: impact_paths.into_iter().collect(),
            allowed_extra_files: extra_files.into_iter().collect(),
            allowed_ancestor_dirs: ancestor_dirs.into_iter().collect(),
        }
    }
}

/// One undeclared workspace file read observed at runtime by the V8 preload read guard.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndeclaredRead {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_file: Option<String>,
}

/// Execution mode for the runtime workspace file-read tracer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadGuardMode {
    /// Fail any task with undeclared workspace reads and refuse to cache its receipt.
    Enforce,
    /// Record undeclared workspace reads on each task without failing the task.
    Audit,
}
