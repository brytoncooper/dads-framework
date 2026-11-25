//! Lightweight Git `HEAD` + working-tree staleness fingerprint for `--plan-file` verification.
//!
//! Captures `HEAD` and a per-path content+mode digest for every dirty or untracked non-ignored
//! file so `dad-test run --plan-file` fails closed whenever the workspace changes after planning
//! while safely ignoring the `--plan-file` output file itself (even when redirected in-workspace).

use crate::scope::path_matches_impact;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFingerprint {
    pub head: String,
    #[serde(default)]
    pub dirty: BTreeMap<String, String>,
}

pub(crate) fn compute_workspace_fingerprint(
    workspace_root: &Path,
    ignore_paths: &[String],
) -> Option<WorkspaceFingerprint> {
    let head_out = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(workspace_root)
        .output()
        .ok()?;
    if !head_out.status.success() {
        return None;
    }
    let head = String::from_utf8(head_out.stdout).ok()?.trim().to_owned();
    if head.is_empty() {
        return None;
    }

    let status_out = Command::new("git")
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .current_dir(workspace_root)
        .output()
        .ok()?;
    if !status_out.status.success() {
        return None;
    }

    let mut dirty = BTreeMap::new();
    let mut records = status_out.stdout.split(|&b| b == 0).peekable();
    while let Some(raw) = records.next() {
        if raw.len() < 4 {
            continue;
        }
        let xy = std::str::from_utf8(&raw[..2]).ok()?;
        let path_str = std::str::from_utf8(&raw[3..]).ok()?;
        let is_rename_or_copy =
            xy.starts_with('R') || xy.starts_with('C') || xy.ends_with('R') || xy.ends_with('C');
        if is_rename_or_copy {
            // In porcelain -z, rename/copy emits a second NUL-terminated original path.
            let _ = records.next();
        }
        if ignore_paths
            .iter()
            .any(|pattern| path_matches_impact(path_str, pattern))
        {
            continue;
        }
        let digest = file_state_digest(&workspace_root.join(path_str));
        dirty.insert(path_str.to_owned(), format!("{xy}:{digest}"));
    }

    Some(WorkspaceFingerprint { head, dirty })
}

pub(crate) fn fingerprints_match(
    expected: &WorkspaceFingerprint,
    actual: &WorkspaceFingerprint,
    excluded_plan_rel: Option<&str>,
) -> bool {
    expected.head == actual.head
        && filtered_dirty(&expected.dirty, excluded_plan_rel)
            == filtered_dirty(&actual.dirty, excluded_plan_rel)
}

fn filtered_dirty<'a>(
    dirty: &'a BTreeMap<String, String>,
    excluded_plan_rel: Option<&str>,
) -> BTreeMap<&'a str, &'a str> {
    dirty
        .iter()
        .filter(|(k, _)| excluded_plan_rel != Some(k.as_str()))
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect()
}

fn file_state_digest(path: &Path) -> String {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return "missing".to_owned();
    };
    if meta.file_type().is_symlink() {
        let target = fs::read_link(path)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        return format!("symlink:{:016x}", fnv1a_64(target.as_bytes(), 0));
    }
    if !meta.is_file() {
        return "nonfile".to_owned();
    }
    let Ok(bytes) = fs::read(path) else {
        return "unreadable".to_owned();
    };
    let exec = if is_executable(&meta) { 'x' } else { 'f' };
    let h1 = fnv1a_64(&bytes, 0xcbf2_9ce4_8422_2325);
    let h2 = fnv1a_64(&bytes, 0x8422_2325_cbf2_9ce4);
    format!("{exec}:{}:{h1:016x}{h2:016x}", bytes.len())
}

fn fnv1a_64(bytes: &[u8], seed: u64) -> u64 {
    let mut hash = seed ^ 0x1000_0000_01b3;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

#[cfg(unix)]
fn is_executable(meta: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_meta: &fs::Metadata) -> bool {
    false
}
