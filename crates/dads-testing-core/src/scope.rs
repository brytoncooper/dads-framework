//! What changed, and who owns it: the request's scope resolved against git, plus the path
//! ownership rules the planner reads it with.
use crate::execute::{TestingError, message};
use crate::git::{git_changed_paths, git_untracked_paths, resolve_git_ref};
use crate::graph::DependencyGraph;
use crate::manifest::{FileNarrowing, Project, TestingManifest, validate_relative_path};
use crate::protocol::{NativeRequest, ResolvedScope};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

const GIT_EMPTY_TREE_SHA1: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GIT_EMPTY_TREE_SHA256: &str =
    "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

pub fn is_empty_tree_sha(sha: &str) -> bool {
    sha.eq_ignore_ascii_case(GIT_EMPTY_TREE_SHA1) || sha.eq_ignore_ascii_case(GIT_EMPTY_TREE_SHA256)
}

fn all_scope(base: Option<String>, head: Option<String>) -> ResolvedScope {
    ResolvedScope {
        kind: "all".into(),
        base,
        head,
        changed_paths: Vec::new(),
        full_fallback: true,
    }
}

fn resolve_base_ref(workspace_root: &Path, base: &str) -> Result<(String, bool), TestingError> {
    if is_empty_tree_sha(base) {
        return Ok((base.to_ascii_lowercase(), true));
    }
    let sha = resolve_git_ref(workspace_root, base)?;
    let empty = is_empty_tree_sha(&sha);
    Ok((sha, empty))
}

pub(crate) fn resolve_scope(
    request: &NativeRequest,
    workspace_root: &Path,
) -> Result<ResolvedScope, TestingError> {
    if request.all {
        return Ok(all_scope(None, None));
    }
    let mut paths = BTreeSet::new();
    let kind;
    let resolved_base;
    let resolved_head;
    match (&request.base, &request.head) {
        (Some(base), Some(head)) => {
            let (base_sha, is_empty) = resolve_base_ref(workspace_root, base)?;
            let head_sha = resolve_git_ref(workspace_root, head)?;
            if is_empty {
                return Ok(all_scope(Some(base_sha), Some(head_sha)));
            }
            resolved_base = Some(base_sha);
            resolved_head = Some(head_sha);
            paths.extend(git_changed_paths(
                workspace_root,
                &["diff", "--name-status", "-z", base, head],
            )?);
            kind = "commit-to-commit";
        }
        (Some(base), None) => {
            let (base_sha, is_empty) = resolve_base_ref(workspace_root, base)?;
            let head_sha = resolve_git_ref(workspace_root, "HEAD")?;
            if is_empty {
                return Ok(all_scope(Some(base_sha), Some(head_sha)));
            }
            resolved_base = Some(base_sha);
            resolved_head = Some(head_sha);
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

/// Matches a workspace-relative path against either a directory/file prefix or a `*`/`**` glob.
pub(crate) fn path_matches_impact(path: &str, declared: &str) -> bool {
    if !declared.contains('*') {
        return path_is_inside(path, declared);
    }
    let path_parts: Vec<&str> = path.split('/').collect();
    let pat_parts: Vec<&str> = declared.split('/').collect();
    match_glob_segments(&path_parts, &pat_parts)
}

fn match_glob_segments(path: &[&str], pattern: &[&str]) -> bool {
    match (path.first(), pattern.first()) {
        (None, None) => true,
        (_, Some(&"**")) => {
            match_glob_segments(path, &pattern[1..])
                || (!path.is_empty() && match_glob_segments(&path[1..], pattern))
        }
        (Some(seg), Some(pat)) => {
            match_wildcard_segment(seg, pat) && match_glob_segments(&path[1..], &pattern[1..])
        }
        _ => false,
    }
}

fn match_wildcard_segment(segment: &str, pattern: &str) -> bool {
    if !pattern.contains('*') {
        return segment == pattern;
    }
    let parts: Vec<&str> = pattern.split('*').collect();
    let mut cursor = segment;
    if let Some(first) = parts.first() {
        let Some(rest) = cursor.strip_prefix(first) else {
            return false;
        };
        cursor = rest;
    }
    if let Some(last) = parts.last()
        && parts.len() > 1
    {
        let Some(rest) = cursor.strip_suffix(last) else {
            return false;
        };
        cursor = rest;
    }
    for middle in &parts[1..parts.len().saturating_sub(1)] {
        if middle.is_empty() {
            continue;
        }
        let Some(pos) = cursor.find(middle) else {
            return false;
        };
        cursor = &cursor[pos + middle.len()..];
    }
    true
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

pub(crate) fn validate_dynamic_import_scopes(
    scopes: &BTreeMap<String, Vec<String>>,
) -> Result<(), TestingError> {
    for (loader, prefixes) in scopes {
        validate_relative_path(loader, "workspace.dynamicImportScopes key")?;
        if prefixes.is_empty() {
            return Err(message(format!(
                "workspace.dynamicImportScopes entry '{loader}' must list at least one path prefix."
            )));
        }
        for prefix in prefixes {
            validate_relative_path(prefix, "workspace.dynamicImportScopes prefix")?;
        }
    }
    Ok(())
}

pub(crate) fn dynamic_import_scope_triggered(
    loader_path: &str,
    allowed_prefixes: &[String],
    changed_paths: &[String],
) -> bool {
    changed_paths.iter().any(|changed| {
        changed == loader_path
            || allowed_prefixes
                .iter()
                .any(|prefix| path_matches_impact(changed, prefix))
    })
}

pub(crate) fn is_test_module_with_narrowings(path: &str, narrowings: &[&FileNarrowing]) -> bool {
    let matches_narrowing = narrowings.iter().any(|n| {
        n.suffixes.iter().any(|s| path.ends_with(s))
            && !n.exclude_suffixes.iter().any(|e| path.ends_with(e))
    });
    if !narrowings.is_empty() {
        return matches_narrowing;
    }
    is_standard_test_path(path)
}

pub(crate) fn is_standard_test_path(path: &str) -> bool {
    const EXTS: &[&str] = &["ts", "tsx", "js", "jsx", "mts", "mjs", "cts", "cjs"];
    path.contains("/__tests__/")
        || path.rsplit_once('.').is_some_and(|(stem, ext)| {
            EXTS.contains(&ext) && (stem.ends_with(".test") || stem.ends_with(".spec"))
        })
}

pub(crate) fn is_isolated_test_file(
    path: &str,
    manifest: &TestingManifest,
    graph: &DependencyGraph,
) -> bool {
    if graph.has_importers(path) {
        return false;
    }
    if is_standard_test_path(path) {
        return true;
    }
    manifest.tasks.iter().any(|task| {
        task.execution.file_narrowing.as_ref().is_some_and(|n| {
            n.suffixes.iter().any(|s| path.ends_with(s))
                && !n.exclude_suffixes.iter().any(|e| path.ends_with(e))
        })
    })
}
