//! Filters out gitignored untracked workspace paths from read-guard violations.
//!
//! Gitignored local files (such as `.env` or `.claude/launch.json`) cannot appear in a Git diff
//! and therefore cannot invalidate task selection; tracked files remain strictly enforced because
//! `git check-ignore` (without `--no-index`) never matches paths in the Git index.

use crate::protocol::UndeclaredRead;
use std::collections::BTreeSet;
use std::io::Write as _;
use std::path::Path;
use std::process::{Command, Stdio};

pub(super) fn filter_gitignored_reads(
    workspace_root: &Path,
    violations: Vec<UndeclaredRead>,
) -> Vec<UndeclaredRead> {
    if violations.is_empty() {
        return violations;
    }
    let Some(ignored) = query_gitignored_paths(workspace_root, &violations) else {
        return violations;
    };
    if ignored.is_empty() {
        return violations;
    }
    violations
        .into_iter()
        .filter(|item| !ignored.contains(item.path.as_str()))
        .collect()
}

fn query_gitignored_paths(
    workspace_root: &Path,
    violations: &[UndeclaredRead],
) -> Option<BTreeSet<String>> {
    let mut child = Command::new("git")
        .args(["check-ignore", "--stdin", "-z"])
        .current_dir(workspace_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    if let Some(mut stdin) = child.stdin.take() {
        for item in violations {
            if item.path == "." {
                continue;
            }
            if stdin.write_all(item.path.as_bytes()).is_err() || stdin.write_all(&[0]).is_err() {
                break;
            }
        }
    }
    let output = child.wait_with_output().ok()?;
    // Exit 0 = one or more paths ignored; exit 1 = none ignored; 128 = not a git repo / error.
    if output.status.code() != Some(0) {
        return Some(BTreeSet::new());
    }
    let mut ignored = BTreeSet::new();
    for raw in output.stdout.split(|&byte| byte == 0) {
        if raw.is_empty() {
            continue;
        }
        if let Ok(path) = std::str::from_utf8(raw) {
            ignored.insert(path.replace('\\', "/"));
        }
    }
    Some(ignored)
}
