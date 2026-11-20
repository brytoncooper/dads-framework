//! What changed, and who owns it: the request's scope resolved against git, plus the path
//! ownership rules the planner reads it with.
use crate::execute::{TestingError, message};
use crate::git::{git_changed_paths, git_untracked_paths, resolve_git_ref};
use crate::manifest::Project;
use crate::protocol::{NativeRequest, ResolvedScope};
use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

pub(crate) fn resolve_scope(
    request: &NativeRequest,
    workspace_root: &Path,
) -> Result<ResolvedScope, TestingError> {
    if request.all {
        return Ok(ResolvedScope {
            kind: "all".into(),
            base: None,
            head: None,
            changed_paths: Vec::new(),
            full_fallback: true,
        });
    }
    let mut paths = BTreeSet::new();
    let kind;
    let resolved_base;
    let resolved_head;
    match (&request.base, &request.head) {
        (Some(base), Some(head)) => {
            resolved_base = Some(resolve_git_ref(workspace_root, base)?);
            resolved_head = Some(resolve_git_ref(workspace_root, head)?);
            paths.extend(git_changed_paths(
                workspace_root,
                &["diff", "--name-status", "-z", base, head],
            )?);
            kind = "commit-to-commit";
        }
        (Some(base), None) => {
            resolved_base = Some(resolve_git_ref(workspace_root, base)?);
            resolved_head = Some(resolve_git_ref(workspace_root, "HEAD")?);
            paths.extend(git_changed_paths(
                workspace_root,
                &["diff", "--name-status", "-z", base, "HEAD"],
            )?);
            paths.extend(git_changed_paths(
                workspace_root,
                &["diff", "--cached", "--name-status", "-z"],
            )?);
            paths.extend(git_changed_paths(
                workspace_root,
                &["diff", "--name-status", "-z"],
            )?);
            paths.extend(git_untracked_paths(workspace_root)?);
            kind = "base-to-working-tree";
        }
        (None, None) => {
            resolved_base = Some(resolve_git_ref(workspace_root, "HEAD")?);
            resolved_head = Some(resolve_git_ref(workspace_root, "HEAD")?);
            paths.extend(git_changed_paths(
                workspace_root,
                &["diff", "--cached", "--name-status", "-z", "HEAD"],
            )?);
            paths.extend(git_changed_paths(
                workspace_root,
                &["diff", "--name-status", "-z", "HEAD"],
            )?);
            paths.extend(git_untracked_paths(workspace_root)?);
            kind = "working-tree";
        }
        (None, Some(_)) => return Err(TestingError::HeadWithoutBase),
    }
    Ok(ResolvedScope {
        kind: kind.into(),
        base: resolved_base,
        head: resolved_head,
        changed_paths: paths.into_iter().collect(),
        full_fallback: false,
    })
}

/// A root of "." is the workspace itself, so it contains every workspace-relative path. Without
/// this, a single-package manifest owns nothing and every change takes the complete fallback.
pub(crate) fn path_is_inside(path: &str, root: &str) -> bool {
    root == "."
        || path == root
        || path
            .strip_prefix(root)
            .is_some_and(|remainder| remainder.starts_with('/'))
}

/// Ownership specificity of a project root. The workspace root owns everything but is the least
/// specific owner, so it must never tie with a declared subdirectory.
fn root_specificity(root: &str) -> usize {
    if root == "." { 0 } else { root.len() }
}

/// Returns the most specific declared project that owns a workspace-relative path.
///
/// Nested project roots are valid, so ownership must not depend on manifest order. An
/// ambiguous tie is treated as unowned and causes the caller's conservative fallback.
pub(crate) fn deepest_project_for_path<'a>(
    projects: &'a [Project],
    path: &str,
) -> Option<&'a Project> {
    let mut owner: Option<&Project> = None;

    for project in projects {
        if !path_is_inside(path, &project.root) {
            continue;
        }

        let specificity = root_specificity(&project.root);
        let deepest_specificity = owner.map(|owner| root_specificity(&owner.root));
        match deepest_specificity {
            None => owner = Some(project),
            Some(deepest) if specificity > deepest => owner = Some(project),
            Some(deepest) if specificity == deepest => return None,
            Some(_) => {}
        }
    }

    owner
}

pub(crate) fn absolute_existing_directory(
    value: &str,
    field: &str,
) -> Result<PathBuf, TestingError> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(message(format!("{field} must be an absolute path.")));
    }
    if !path.is_dir() {
        return Err(message(format!(
            "{field} is not a directory: {}",
            path.display()
        )));
    }
    path.canonicalize()
        .map_err(|error| message(format!("Unable to resolve {field}: {error}")))
}

fn resolve_inside(root: &Path, relative: &Path, field: &str) -> Result<PathBuf, TestingError> {
    if relative.is_absolute() {
        return Err(message(format!(
            "{field} must be relative to the workspace."
        )));
    }
    for component in relative.components() {
        if matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return Err(message(format!("{field} must not escape the workspace.")));
        }
    }
    Ok(root.join(relative))
}

pub(crate) fn resolve_existing_inside(
    root: &Path,
    relative: &Path,
    field: &str,
) -> Result<PathBuf, TestingError> {
    let candidate = resolve_inside(root, relative, field)?;
    let resolved = candidate
        .canonicalize()
        .map_err(|error| message(format!("Unable to resolve {field}: {error}")))?;
    if !resolved.starts_with(root) {
        return Err(message(format!(
            "{field} escapes the workspace through a symbolic link."
        )));
    }
    Ok(resolved)
}
