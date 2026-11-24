//! Discovering JavaScript and TypeScript source files for analysis.
//!
//! Inside a Git repository, discovery asks Git for tracked files plus unignored untracked files so
//! gitignored build outputs (`cdk.out`, `.nx`) and nested worktrees (`.claude/worktrees/`) are
//! never scanned. Outside a Git repository (such as standalone test fixtures), it falls back to
//! directory traversal with a conservative ignore list.

use crate::facts::JsUncertainty;
use crate::workspace::{git_output, is_javascript_path, uncertainty};
use std::fs;
use std::path::{Path, PathBuf};

const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    ".nx",
    ".turbo",
    ".claude",
    ".worktrees",
    "cdk.out",
    ".lake",
    "_apalache-out",
];

pub(crate) fn discover_javascript_files(
    workspace_root: &Path,
    project_roots: Option<&[String]>,
    uncertainties: &mut Vec<JsUncertainty>,
) -> Vec<PathBuf> {
    let mut files = if let Some(git_files) =
        collect_git_javascript_files(workspace_root, project_roots)
    {
        git_files
    } else {
        let mut discovered = Vec::new();
        let scan_roots = resolve_scan_roots(workspace_root, project_roots);
        let scoped = scan_roots.len() > 1
            || scan_roots
                .first()
                .is_some_and(|root| root != workspace_root);
        for scan_root in scan_roots {
            collect_javascript_files(workspace_root, &scan_root, &mut discovered, uncertainties);
        }
        if scoped {
            collect_root_javascript_files(workspace_root, &mut discovered);
        }
        discovered
    };
    files.sort();
    files.dedup();
    files
}

fn collect_git_javascript_files(
    workspace_root: &Path,
    project_roots: Option<&[String]>,
) -> Option<Vec<PathBuf>> {
    let output = git_output(
        workspace_root,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
    )?;
    if !output.is_empty() && output.last() != Some(&0) {
        return None;
    }
    let normalized_roots = normalize_project_roots(project_roots);
    let mut files = Vec::new();
    for raw in output.split(|byte| *byte == 0) {
        if raw.is_empty() {
            continue;
        }
        let Ok(rel) = std::str::from_utf8(raw) else {
            continue;
        };
        if !is_javascript_path(Path::new(rel)) {
            continue;
        }
        if let Some(roots) = &normalized_roots {
            let in_root = !rel.contains('/')
                || roots
                    .iter()
                    .any(|root| rel == root || rel.starts_with(&format!("{root}/")));
            if !in_root {
                continue;
            }
        }
        let absolute = workspace_root.join(rel);
        if absolute.is_file() {
            files.push(absolute);
        }
    }
    Some(files)
}

fn normalize_project_roots(project_roots: Option<&[String]>) -> Option<Vec<String>> {
    let roots = project_roots?;
    if roots.is_empty()
        || roots.iter().any(|root| {
            let trimmed = root.trim().trim_end_matches('/');
            trimmed.is_empty() || trimmed == "."
        })
    {
        return None;
    }
    Some(
        roots
            .iter()
            .map(|root| root.trim().trim_matches('/').to_owned())
            .filter(|root| !root.is_empty())
            .collect(),
    )
}

/// Uses manifest project roots when none declares the workspace root `"."`, avoiding spurious
/// uncertainties from unrelated repo scripts or fixtures outside declared projects.
fn resolve_scan_roots(workspace_root: &Path, project_roots: Option<&[String]>) -> Vec<PathBuf> {
    let Some(roots) = normalize_project_roots(project_roots) else {
        return vec![workspace_root.to_path_buf()];
    };
    let mut resolved = roots
        .iter()
        .map(|root| workspace_root.join(root))
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    resolved.sort();
    resolved.dedup();
    if resolved.is_empty() {
        vec![workspace_root.to_path_buf()]
    } else {
        resolved
    }
}

fn collect_root_javascript_files(workspace_root: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(workspace_root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().is_ok_and(|kind| kind.is_file()) && is_javascript_path(&path) {
            files.push(path);
        }
    }
}

fn collect_javascript_files(
    workspace_root: &Path,
    directory: &Path,
    files: &mut Vec<PathBuf>,
    uncertainties: &mut Vec<JsUncertainty>,
) {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) => {
            uncertainties.push(uncertainty(
                workspace_root,
                directory,
                "javascript-directory-read-failed",
                format!("Could not inspect JavaScript sources: {error}"),
            ));
            return;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                uncertainties.push(JsUncertainty {
                    path: String::new(),
                    code: "javascript-directory-entry-failed".to_owned(),
                    message: format!("Could not inspect a workspace entry: {error}"),
                    span: None,
                    position: None,
                });
                continue;
            }
        };
        let path = entry.path();
        let file_name = entry.file_name();
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            if file_name
                .to_str()
                .is_some_and(|name| IGNORED_DIRS.contains(&name))
            {
                continue;
            }
            collect_javascript_files(workspace_root, &path, files, uncertainties);
        } else if is_javascript_path(&path) {
            files.push(path);
        }
    }
}
