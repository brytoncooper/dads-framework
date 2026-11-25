//! Walking `tsconfig*.json` `"extends"` chains (including sideways cross-package presets,
//! TypeScript 5 array `extends`, extensionless specifiers, and workspace-symlinked `node_modules`
//! presets) for planner widening, `v5` cache receipts, and read-guard allowlists.

use crate::tsconfig_parse::parse_tsconfig_jsonc;
use serde_json::Value;
use std::collections::{BTreeSet, VecDeque};
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

/// Walks every workspace file transitively extended by `tsconfig_rel` via `"extends"`.
///
/// Returns `Some(paths)` containing workspace-relative paths of all resolved workspace configs
/// reachable from `tsconfig_rel` (excluding `tsconfig_rel` itself and external npm packages inside
/// `node_modules`). Returns `None` (fail closed) on unreadable files, malformed JSONC, invalid
/// `"extends"` syntax, missing relative targets, or symlinks escaping the workspace.
pub fn collect_tsconfig_extends_chain(
    workspace_root: &Path,
    tsconfig_rel: &str,
) -> Option<BTreeSet<String>> {
    let canonical_root = workspace_root.canonicalize().ok()?;
    let mut visited = BTreeSet::new();
    let mut extended = BTreeSet::new();
    let mut queue = VecDeque::new();
    visited.insert(tsconfig_rel.to_owned());
    queue.push_back(tsconfig_rel.to_owned());

    while let Some(current_rel) = queue.pop_front() {
        let current_path = workspace_root.join(&current_rel);
        let raw = fs::read_to_string(&current_path).ok()?;
        let parsed = parse_tsconfig_jsonc(&raw)?;
        let specs = extract_extends_specifiers(&parsed)?;
        let current_dir = current_rel.rsplit_once('/').map_or("", |(dir, _)| dir);
        for spec in specs {
            match resolve_extends_target(workspace_root, &canonical_root, current_dir, &spec)? {
                ExtendsTarget::WorkspaceFile(target_rel) => {
                    if visited.insert(target_rel.clone()) {
                        extended.insert(target_rel.clone());
                        queue.push_back(target_rel);
                    }
                }
                ExtendsTarget::ExternalPackage => {}
            }
        }
    }
    Some(extended)
}

/// Collects all `tsconfig*.json` files directly inside `dir_rel` (or workspace root if empty).
/// Returns `None` if a `tsconfig*.json` entry is a symlink or unreadable.
pub fn list_tsconfig_files_in_dir(workspace_root: &Path, dir_rel: &str) -> Option<Vec<String>> {
    let dir_path = if dir_rel.is_empty() {
        workspace_root.to_path_buf()
    } else {
        workspace_root.join(dir_rel)
    };
    let entries = match fs::read_dir(&dir_path) {
        Ok(entries) => entries,
        Err(err) if err.kind() == ErrorKind::NotFound => return Some(Vec::new()),
        Err(_) => return None,
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.ok()?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !name.starts_with("tsconfig") || !name.ends_with(".json") {
            continue;
        }
        let meta = fs::symlink_metadata(entry.path()).ok()?;
        if meta.file_type().is_symlink() {
            return None;
        }
        if meta.is_file() {
            let rel = if dir_rel.is_empty() {
                name
            } else {
                format!("{dir_rel}/{name}")
            };
            out.push(rel);
        }
    }
    out.sort();
    Some(out)
}

/// Collects every workspace file transitively extended by any `tsconfig*.json` in `project_roots`
/// or their ancestor directories (best-effort; skips broken chains cleanly for allowlist usage).
pub fn collect_project_tsconfig_extends_allowlist(
    workspace_root: &Path,
    project_roots: &[String],
) -> Vec<String> {
    let mut dirs = BTreeSet::new();
    dirs.insert(String::new());
    for raw_root in project_roots {
        let trimmed = raw_root.trim().trim_matches('/');
        if trimmed.is_empty() || trimmed == "." {
            continue;
        }
        let mut cursor = trimmed;
        loop {
            dirs.insert(cursor.to_owned());
            let Some((parent, _)) = cursor.rsplit_once('/') else {
                break;
            };
            cursor = parent;
        }
    }
    let mut out = BTreeSet::new();
    for dir_rel in dirs {
        let Some(tsconfigs) = list_tsconfig_files_in_dir(workspace_root, &dir_rel) else {
            continue;
        };
        for tsconfig_rel in tsconfigs {
            if let Some(chain) = collect_tsconfig_extends_chain(workspace_root, &tsconfig_rel) {
                out.extend(chain);
            }
        }
    }
    out.into_iter().collect()
}

enum ExtendsTarget {
    WorkspaceFile(String),
    ExternalPackage,
}

fn extract_extends_specifiers(parsed: &Value) -> Option<Vec<String>> {
    let obj = parsed.as_object()?;
    match obj.get("extends") {
        None | Some(Value::Null) => Some(Vec::new()),
        Some(Value::String(spec)) => Some(vec![spec.clone()]),
        Some(Value::Array(items)) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(item.as_str()?.to_owned());
            }
            Some(out)
        }
        Some(_) => None,
    }
}

fn resolve_extends_target(
    workspace_root: &Path,
    canonical_root: &Path,
    current_dir: &str,
    specifier: &str,
) -> Option<ExtendsTarget> {
    let trimmed = specifier.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("./") || trimmed.starts_with("../") || trimmed == "." || trimmed == ".."
    {
        let joined = if current_dir.is_empty() {
            trimmed.to_owned()
        } else {
            format!("{current_dir}/{trimmed}")
        };
        let norm = normalize_workspace_relative(&joined)?;
        for candidate in tsconfig_resolution_candidates(&norm) {
            let full = workspace_root.join(&candidate);
            match fs::symlink_metadata(&full) {
                Ok(meta) => {
                    if meta.file_type().is_symlink() {
                        return None;
                    }
                    if meta.is_file() {
                        return Some(ExtendsTarget::WorkspaceFile(candidate));
                    }
                }
                Err(err) if err.kind() == ErrorKind::NotFound => continue,
                Err(_) => return None,
            }
        }
        return None;
    }
    resolve_bare_extends_target(workspace_root, canonical_root, current_dir, trimmed)
}

fn resolve_bare_extends_target(
    workspace_root: &Path,
    canonical_root: &Path,
    current_dir: &str,
    specifier: &str,
) -> Option<ExtendsTarget> {
    let mut cursor = Some(current_dir);
    while let Some(dir) = cursor {
        let base_nm = if dir.is_empty() {
            workspace_root.join("node_modules")
        } else {
            workspace_root.join(dir).join("node_modules")
        };
        for candidate_rel in tsconfig_resolution_candidates(specifier) {
            let candidate = base_nm.join(&candidate_rel);
            if candidate.is_file() {
                let canonical = candidate.canonicalize().ok()?;
                if let Some(rel) = workspace_rel_outside_node_modules(canonical_root, &canonical) {
                    return Some(ExtendsTarget::WorkspaceFile(rel));
                }
                return Some(ExtendsTarget::ExternalPackage);
            }
        }
        cursor = if dir.is_empty() {
            None
        } else {
            Some(dir.rsplit_once('/').map_or("", |(parent, _)| parent))
        };
    }
    // External package preset not present on disk (e.g. pruned install or optional preset):
    // do not fail closed on unresolved bare npm presets.
    Some(ExtendsTarget::ExternalPackage)
}

fn tsconfig_resolution_candidates(base: &str) -> Vec<String> {
    let trimmed = base.trim_end_matches('/');
    let mut out = vec![trimmed.to_owned()];
    if !trimmed.ends_with(".json") {
        out.push(format!("{trimmed}.json"));
        out.push(format!("{trimmed}/tsconfig.json"));
    }
    out
}

fn normalize_workspace_relative(raw: &str) -> Option<String> {
    let mut stack: Vec<&str> = Vec::new();
    for component in Path::new(raw).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => stack.push(part.to_str()?),
            Component::ParentDir => {
                stack.pop()?;
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if stack.is_empty() {
        return None;
    }
    Some(stack.join("/"))
}

fn workspace_rel_outside_node_modules(
    canonical_root: &Path,
    canonical_path: &Path,
) -> Option<String> {
    let rel_path: PathBuf = canonical_path
        .strip_prefix(canonical_root)
        .ok()?
        .to_path_buf();
    let rel = rel_path.to_string_lossy().replace('\\', "/");
    if rel
        .split('/')
        .any(|segment| matches!(segment, "node_modules" | ".git"))
    {
        return None;
    }
    Some(rel)
}
