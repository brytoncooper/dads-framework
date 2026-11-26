//! Discovering JavaScript and TypeScript source files for analysis.
//!
//! Inside a Git repository, discovery asks Git for tracked files plus unignored untracked files so
//! gitignored build outputs (`cdk.out`, `.nx`) and nested worktrees (`.claude/worktrees/`) are
//! never scanned. Outside a Git repository (such as standalone test fixtures), it falls back to
//! directory traversal with a conservative ignore list.

use crate::external_packages::ExternalPackageIndex;
use crate::facts::JsUncertainty;
use crate::workspace::{git_output, is_javascript_path, uncertainty, workspace_relative_path};
use std::collections::HashSet;
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

/// Sorted workspace file inventory built once per analysis pass so static `fs` directory reads and
/// `import.meta.glob` patterns resolve in O(log N) via binary search.
#[derive(Debug, Default)]
pub(crate) struct WorkspaceFileIndex {
    files: Vec<String>,
    canonical_root: Option<PathBuf>,
    external_packages: ExternalPackageIndex,
}

impl WorkspaceFileIndex {
    pub(crate) fn build(workspace_root: &Path) -> Self {
        let canonical_root = workspace_root.canonicalize().ok();
        let mut files = collect_git_workspace_files(workspace_root).unwrap_or_else(|| {
            let mut discovered = Vec::new();
            collect_all_workspace_files(workspace_root, workspace_root, &mut discovered);
            discovered
        });
        files.sort();
        files.dedup();
        let external_packages = ExternalPackageIndex::build(workspace_root, &files);
        Self {
            files,
            canonical_root,
            external_packages,
        }
    }

    pub(crate) fn canonical_root(&self) -> Option<&Path> {
        self.canonical_root.as_deref()
    }

    pub(crate) fn is_known_external_specifier(&self, specifier: &str) -> bool {
        self.external_packages
            .is_known_external_specifier(specifier)
    }

    /// Returns all indexed workspace files strictly underneath `dir_rel` using O(log N) range
    /// binary search. Refuses to expand the workspace root itself.
    pub(crate) fn files_under_dir(&self, dir_rel: &str) -> &[String] {
        let trimmed = dir_rel.trim_matches('/');
        if trimmed.is_empty() || trimmed == "." {
            return &[];
        }
        let prefix = format!("{trimmed}/");
        let start = self
            .files
            .partition_point(|path| path.as_str() < prefix.as_str());
        let len = self.files[start..].partition_point(|path| path.starts_with(&prefix));
        &self.files[start..start + len]
    }
}

pub(crate) fn is_ignored_workspace_rel_path(rel: &str) -> bool {
    rel.split('/')
        .any(|segment| IGNORED_DIRS.contains(&segment))
}

fn collect_git_workspace_files(workspace_root: &Path) -> Option<Vec<String>> {
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
    let deleted: Option<HashSet<String>> =
        git_output(workspace_root, &["ls-files", "--deleted", "-z"]).and_then(|raw_deleted| {
            if !raw_deleted.is_empty() && raw_deleted.last() != Some(&0) {
                return None;
            }
            Some(
                raw_deleted
                    .split(|byte| *byte == 0)
                    .filter(|entry| !entry.is_empty())
                    .filter_map(|entry| std::str::from_utf8(entry).ok())
                    .map(|rel| rel.replace('\\', "/"))
                    .collect(),
            )
        });
    let mut files = Vec::new();
    for raw in output.split(|byte| *byte == 0) {
        if raw.is_empty() {
            continue;
        }
        let Ok(rel) = std::str::from_utf8(raw) else {
            continue;
        };
        let normalized = rel.replace('\\', "/");
        if is_ignored_workspace_rel_path(&normalized) {
            continue;
        }
        let exists = match &deleted {
            Some(deleted_set) => !deleted_set.contains(&normalized),
            None => workspace_root.join(&normalized).is_file(),
        };
        if exists {
            files.push(normalized);
        }
    }
    Some(files)
}

fn collect_all_workspace_files(workspace_root: &Path, directory: &Path, files: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = entry.file_name();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            if file_name
                .to_str()
                .is_some_and(|name| IGNORED_DIRS.contains(&name))
            {
                continue;
            }
            collect_all_workspace_files(workspace_root, &path, files);
        } else if file_type.is_file()
            && let Some(rel) = workspace_relative_path(workspace_root, &path)
            && !is_ignored_workspace_rel_path(&rel)
        {
            files.push(rel);
        }
    }
}

pub(crate) fn discover_javascript_files(
    workspace_root: &Path,
    project_roots: Option<&[String]>,
    ignore_paths: &[String],
    uncertainties: &mut Vec<JsUncertainty>,
) -> Vec<PathBuf> {
    let mut files = if let Some(git_files) =
        collect_git_javascript_files(workspace_root, project_roots, ignore_paths)
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
            collect_javascript_files(
                workspace_root,
                &scan_root,
                ignore_paths,
                &mut discovered,
                uncertainties,
            );
        }
        if scoped {
            collect_root_javascript_files(workspace_root, ignore_paths, &mut discovered);
        }
        discovered
    };
    files.sort();
    files.dedup();
    files
}

fn matches_ignore_paths(rel: &str, ignore_paths: &[String]) -> bool {
    ignore_paths
        .iter()
        .any(|pattern| dads_testing_core::path_matches_impact(rel, pattern))
}

fn collect_git_javascript_files(
    workspace_root: &Path,
    project_roots: Option<&[String]>,
    ignore_paths: &[String],
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
        let normalized_rel = rel.replace('\\', "/");
        if matches_ignore_paths(&normalized_rel, ignore_paths) {
            continue;
        }
        if let Some(roots) = &normalized_roots {
            let in_root = !normalized_rel.contains('/')
                || roots.iter().any(|root| {
                    normalized_rel == *root || normalized_rel.starts_with(&format!("{root}/"))
                });
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

fn collect_root_javascript_files(
    workspace_root: &Path,
    ignore_paths: &[String],
    files: &mut Vec<PathBuf>,
) {
    let Ok(entries) = fs::read_dir(workspace_root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().is_ok_and(|kind| kind.is_file())
            && is_javascript_path(&path)
            && !workspace_relative_path(workspace_root, &path)
                .is_some_and(|rel| matches_ignore_paths(&rel, ignore_paths))
        {
            files.push(path);
        }
    }
}

fn collect_javascript_files(
    workspace_root: &Path,
    directory: &Path,
    ignore_paths: &[String],
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
            collect_javascript_files(workspace_root, &path, ignore_paths, files, uncertainties);
        } else if is_javascript_path(&path)
            && !workspace_relative_path(workspace_root, &path)
                .is_some_and(|rel| matches_ignore_paths(&rel, ignore_paths))
        {
            files.push(path);
        }
    }
}
