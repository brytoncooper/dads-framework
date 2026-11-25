//! Collects every content-hashed workspace file contributing to a task receipt key.
//!
//! Fails closed (`None`) on any symlink, unreadable file, path traversal, or non-UTF-8 entry.

use crate::receipt_cache::{FileDigestEntry, GitFileInventory, RunMemoCache};
use crate::receipt_policy::{
    collect_policy_files, collect_project_and_ancestor_configs, collect_root_tsconfig_files,
    expand_tsconfig_extends_files,
};
use dads_testing_core::{TaskReceiptRequest, path_matches_impact};
use std::collections::BTreeSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path};

const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    "target",
    ".lake",
    "_apalache-out",
];

pub(crate) struct CollectedReceiptInputs {
    pub(crate) files: BTreeSet<String>,
    pub(crate) missing_extra_files: BTreeSet<String>,
}

pub(crate) fn collect_receipt_input_files(
    request: &TaskReceiptRequest<'_>,
    memo: &RunMemoCache,
) -> Option<CollectedReceiptInputs> {
    let mut files = BTreeSet::new();
    let mut missing_extra_files = BTreeSet::new();

    collect_policy_files(request.workspace_root, &mut files)?;
    collect_root_tsconfig_files(request.workspace_root, &mut files)?;
    collect_project_and_ancestor_configs(
        request.workspace_root,
        request.project_roots,
        &mut files,
    )?;
    expand_tsconfig_extends_files(request.workspace_root, &mut files)?;
    collect_extra_input_files(request, memo, &mut files, &mut missing_extra_files)?;

    for impact_path in request.impact_paths {
        if !is_safe_relative_path(impact_path) {
            return None;
        }
    }

    if let Some(git_files) = collect_git_input_files(
        request.workspace_root,
        request.project_roots,
        request.impact_paths,
        memo,
    )? {
        files.extend(git_files);
    } else {
        collect_fs_input_files(
            request.workspace_root,
            request.project_roots,
            request.impact_paths,
            &mut files,
        )?;
    }

    missing_extra_files.retain(|path| !files.contains(path));
    Some(CollectedReceiptInputs {
        files,
        missing_extra_files,
    })
}

fn collect_extra_input_files(
    request: &TaskReceiptRequest<'_>,
    memo: &RunMemoCache,
    files: &mut BTreeSet<String>,
    missing_extra_files: &mut BTreeSet<String>,
) -> Option<()> {
    for raw in request.setup_files.iter().chain(request.extra_files.iter()) {
        if !is_safe_relative_path(raw) {
            return None;
        }
        let candidate = request.workspace_root.join(raw);
        match memo.file_entry(&candidate) {
            FileDigestEntry::Regular(_, _) => {
                files.insert(raw.clone());
            }
            FileDigestEntry::Missing => {
                missing_extra_files.insert(raw.clone());
            }
            FileDigestEntry::NonRegularOrUnreadable => return None,
        }
    }
    Some(())
}

fn collect_git_input_files(
    workspace_root: &Path,
    project_roots: &[String],
    impact_paths: &[String],
    memo: &RunMemoCache,
) -> Option<Option<BTreeSet<String>>> {
    let all_files = match memo.git_inventory(workspace_root) {
        GitFileInventory::Files(files) => files,
        GitFileInventory::Unavailable => return Some(None),
        GitFileInventory::InvalidEncoding => return None,
    };
    let mut collected = BTreeSet::new();
    for rel in all_files.iter() {
        let matched = matches_any_project_root(rel, project_roots)
            || impact_paths
                .iter()
                .any(|pattern| path_matches_impact(rel, pattern));
        if !matched {
            continue;
        }
        let candidate = workspace_root.join(rel);
        match memo.file_entry(&candidate) {
            FileDigestEntry::Regular(_, _) => {
                collected.insert(rel.clone());
            }
            FileDigestEntry::Missing => {}
            FileDigestEntry::NonRegularOrUnreadable => return None,
        }
    }
    // Also walk every declared impact path (exact file, directory, or glob) directly on disk so
    // gitignored generated files (for example `generated/*.json`) and symlinks outside Git's
    // inventory are always hashed or fail closed.
    for pattern in impact_paths {
        collect_fs_impact_path(workspace_root, pattern, &mut collected)?;
    }
    Some(Some(collected))
}

fn collect_fs_input_files(
    workspace_root: &Path,
    project_roots: &[String],
    impact_paths: &[String],
    files: &mut BTreeSet<String>,
) -> Option<()> {
    for root in project_roots {
        if !is_safe_relative_path(root) {
            return None;
        }
        let trimmed = normalize_non_glob_path(root);
        let (start, prefix) = if trimmed.is_empty() || trimmed == "." {
            (workspace_root.to_path_buf(), String::new())
        } else {
            (workspace_root.join(trimmed), trimmed.to_owned())
        };
        match fs::symlink_metadata(&start) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return None;
                }
                if meta.is_file() {
                    files.insert(prefix);
                } else if meta.is_dir() {
                    walk_regular_files_matching(&start, &prefix, files, &|_| true)?;
                }
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => return None,
        }
    }
    for impact_path in impact_paths {
        collect_fs_impact_path(workspace_root, impact_path, files)?;
    }
    Some(())
}

fn collect_fs_impact_path(
    workspace_root: &Path,
    pattern: &str,
    files: &mut BTreeSet<String>,
) -> Option<()> {
    if !pattern.contains('*') {
        let trimmed = normalize_non_glob_path(pattern);
        let (target, prefix) = if trimmed.is_empty() || trimmed == "." {
            (workspace_root.to_path_buf(), String::new())
        } else {
            (workspace_root.join(trimmed), trimmed.to_owned())
        };
        match fs::symlink_metadata(&target) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return None;
                }
                if meta.is_file() {
                    files.insert(prefix);
                } else if meta.is_dir() {
                    walk_regular_files_matching(&target, &prefix, files, &|_| true)?;
                } else {
                    return None;
                }
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => return None,
        }
        return Some(());
    }
    let literal_prefix = glob_literal_prefix(pattern);
    let start = if literal_prefix.is_empty() {
        workspace_root.to_path_buf()
    } else {
        workspace_root.join(&literal_prefix)
    };
    match fs::symlink_metadata(&start) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return None;
            }
            if meta.is_dir() {
                walk_regular_files_matching(&start, &literal_prefix, files, &|rel| {
                    path_matches_impact(rel, pattern)
                })?;
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(_) => return None,
    }
    Some(())
}

fn glob_literal_prefix(pattern: &str) -> String {
    let mut segments = Vec::new();
    for segment in pattern.split('/') {
        if segment.contains('*') {
            break;
        }
        if !segment.is_empty() {
            segments.push(segment);
        }
    }
    segments.join("/")
}

fn normalize_non_glob_path(raw: &str) -> &str {
    let trimmed = raw.trim();
    if trimmed == "." {
        "."
    } else {
        trimmed.trim_end_matches('/')
    }
}

fn is_safe_relative_path(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }
    let path = Path::new(trimmed);
    !path.is_absolute()
        && !path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
}

fn matches_any_project_root(rel: &str, project_roots: &[String]) -> bool {
    project_roots.iter().any(|root| {
        let trimmed = root.trim().trim_matches('/');
        trimmed.is_empty()
            || trimmed == "."
            || rel == trimmed
            || rel
                .strip_prefix(trimmed)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

fn walk_regular_files_matching(
    dir: &Path,
    prefix: &str,
    out: &mut BTreeSet<String>,
    predicate: &impl Fn(&str) -> bool,
) -> Option<()> {
    let dir_meta = fs::symlink_metadata(dir).ok()?;
    if dir_meta.file_type().is_symlink() {
        return None;
    }
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries {
        let entry = entry.ok()?;
        let name = entry.file_name().to_str()?.to_owned();
        if IGNORED_DIRS.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).ok()?;
        if meta.file_type().is_symlink() {
            return None;
        }
        let rel = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        if meta.is_dir() {
            walk_regular_files_matching(&path, &rel, out, predicate)?;
        } else if meta.is_file() && predicate(&rel) {
            out.insert(rel);
        }
    }
    Some(())
}
