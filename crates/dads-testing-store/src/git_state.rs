//! Everything the store learns by asking Git.
//!
//! The snapshot is keyed by the state Git reports for the current head, so this module is the only
//! place that shells out to `git`, and the only place that decides which working-tree paths a
//! snapshot has to account for. Every read fails closed: an answer Git will not give, or a path
//! that escapes the workspace through a symlink, yields `None` rather than a guess.

use dads_testing_core::NativeRequest;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::snapshot::{ChangedFingerprint, stable_digest};

/// Policy files whose contents change resolution for every module, so they always take part in the
/// fingerprint even when Git reports them as unchanged.
const RESOLUTION_POLICY_FILES: [&str; 5] = [
    "tsconfig.json",
    "jsconfig.json",
    "package.json",
    "vite.config.ts",
    "webpack.config.js",
];

#[derive(Debug, Clone)]
pub(crate) struct GitState {
    pub(crate) head_sha: String,
    pub(crate) scope_signature: String,
    pub(crate) changed_fingerprints: Vec<ChangedFingerprint>,
}

pub(crate) fn canonical_workspace(request: &NativeRequest) -> Option<PathBuf> {
    Path::new(&request.workspace_root).canonicalize().ok()
}

pub(crate) fn git_dir(workspace: &Path) -> Option<PathBuf> {
    git(
        workspace,
        &["rev-parse", "--path-format=absolute", "--git-dir"],
    )
    .map(|output| PathBuf::from(strip_git_line_ending(&output)))
}

/// The current-head state a snapshot may be keyed by, or `None` when the request compares against
/// something other than the current head and therefore must not reuse or write one.
pub(crate) fn indexed_git_state(workspace: &Path, request: &NativeRequest) -> Option<GitState> {
    if request.head.is_some() || request.all {
        return None;
    }
    let head_sha =
        git(workspace, &["rev-parse", "HEAD"]).map(|output| strip_git_line_ending(&output))?;
    let comparison_base = request.base.as_deref().unwrap_or("HEAD");
    let resolved_base_sha = resolve_commit(workspace, comparison_base)?;
    let scope_signature = format!("base={resolved_base_sha};all=false");
    let mut paths = changed_paths(workspace)?;
    for policy in RESOLUTION_POLICY_FILES {
        if workspace.join(policy).is_file() {
            paths.push(policy.to_owned())
        }
    }
    paths.sort();
    paths.dedup();
    let mut changed_fingerprints = Vec::new();
    for path in paths {
        changed_fingerprints.push(fingerprint_changed_path(workspace, path)?);
    }
    Some(GitState {
        head_sha,
        scope_signature,
        changed_fingerprints,
    })
}

fn resolve_commit(workspace: &Path, reference: &str) -> Option<String> {
    let revision = format!("{reference}^{{commit}}");
    git(
        workspace,
        &["rev-parse", "--verify", "--end-of-options", &revision],
    )
    .map(|output| strip_git_line_ending(&output))
}

fn changed_paths(workspace: &Path) -> Option<Vec<String>> {
    let mut paths = git(
        workspace,
        &["diff", "--no-renames", "--name-only", "-z", "HEAD", "--"],
    )?
    .split('\0')
    .filter(|path| !path.is_empty())
    .map(str::to_owned)
    .collect::<Vec<_>>();
    paths.extend(
        git(
            workspace,
            &["ls-files", "--others", "--exclude-standard", "-z", "--"],
        )?
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_owned),
    );
    paths.sort();
    paths.dedup();
    Some(paths)
}

fn fingerprint_changed_path(workspace: &Path, path: String) -> Option<ChangedFingerprint> {
    let candidate = workspace.join(&path);
    let metadata = match fs::symlink_metadata(&candidate) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !missing_path_is_safe(workspace, &candidate)? {
                return None;
            }
            return Some(ChangedFingerprint {
                path,
                digest: "missing".to_owned(),
            });
        }
        Err(_) => return None,
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return None;
    }
    let canonical = candidate.canonicalize().ok()?;
    if !canonical.starts_with(workspace) {
        return None;
    }
    Some(ChangedFingerprint {
        path,
        digest: stable_digest(&fs::read(canonical).ok()?),
    })
}

fn missing_path_is_safe(workspace: &Path, candidate: &Path) -> Option<bool> {
    let relative = candidate.strip_prefix(workspace).ok()?;
    let mut current = workspace.to_owned();
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Some(false),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Some(true),
            Err(_) => return None,
        }
    }
    Some(true)
}

fn git(workspace: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(workspace)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8(output.stdout).ok())
        .flatten()
}

fn strip_git_line_ending(value: &str) -> String {
    value
        .trim_end_matches('\n')
        .trim_end_matches('\r')
        .to_owned()
}
