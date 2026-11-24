//! Filesystem discovery of workspace project manifests (`project.json` / `package.json`) for
//! declarative `workspace.discover` manifests.

use crate::execute::{TestingError, message};
use crate::scope::path_matches_impact;
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    "target",
    ".next",
    ".nx",
    ".lake",
    "_apalache-out",
];

#[derive(Debug, Clone)]
pub(crate) struct DiscoveredProject {
    pub(crate) id: String,
    pub(crate) root: String,
    pub(crate) tags: BTreeSet<String>,
    pub(crate) targets: BTreeSet<String>,
    pub(crate) fallback_dependencies: Vec<String>,
}

pub(crate) fn discover_projects(
    workspace_root: &Path,
    project_files: &[String],
    exclude_roots: &[String],
) -> Result<Vec<DiscoveredProject>, TestingError> {
    let mut matched_files = Vec::new();
    walk_matching_files(workspace_root, "", project_files, &mut matched_files)?;
    matched_files.sort();
    matched_files.dedup();

    let mut projects = Vec::new();
    for rel_file in matched_files {
        let root = parent_posix(&rel_file);
        if exclude_roots.iter().any(|pattern| {
            path_matches_impact(&root, pattern) || path_matches_impact(&rel_file, pattern)
        }) {
            continue;
        }
        let full = workspace_root.join(&rel_file);
        let project = parse_project_file(&full, &rel_file, &root)?;
        projects.push(project);
    }
    projects.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then_with(|| left.root.cmp(&right.root))
    });
    Ok(projects)
}

fn walk_matching_files(
    dir: &Path,
    prefix: &str,
    patterns: &[String],
    out: &mut Vec<String>,
) -> Result<(), TestingError> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(());
    };
    let mut children = Vec::new();
    for entry in entries.flatten() {
        children.push(entry);
    }
    children.sort_by_key(|entry| entry.file_name());
    for entry in children {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if meta.is_dir() {
            if IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk_matching_files(&path, &rel, patterns, out)?;
        } else if meta.is_file()
            && patterns
                .iter()
                .any(|pattern| path_matches_impact(&rel, pattern))
        {
            out.push(rel);
        }
    }
    Ok(())
}

fn parse_project_file(
    full_path: &Path,
    rel_file: &str,
    root: &str,
) -> Result<DiscoveredProject, TestingError> {
    let raw = fs::read_to_string(full_path).map_err(|error| {
        message(format!(
            "Unable to read discovered project file {rel_file}: {error}"
        ))
    })?;
    let cleaned = strip_jsonc(&raw);
    let json: Value = serde_json::from_str(&cleaned).map_err(|error| {
        message(format!(
            "Invalid JSON in discovered project file {rel_file}: {error}"
        ))
    })?;
    let object = json.as_object().ok_or_else(|| {
        message(format!(
            "Discovered project file {rel_file} must be a JSON object."
        ))
    })?;
    let raw_name = object
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let id = match raw_name {
        Some(name) => normalize_identifier(name),
        None => normalize_identifier(if root == "." { "root" } else { root }),
    };
    let tags = read_string_set(object.get("tags"));
    let mut targets = read_object_keys(object.get("targets"));
    if targets.is_empty() {
        targets = read_object_keys(object.get("scripts"));
    }
    let mut dep_set = BTreeSet::new();
    for key in ["fallbackDependencies", "implicitDependencies"] {
        if let Some(items) = object.get(key).and_then(Value::as_array) {
            for raw in items.iter().filter_map(Value::as_str) {
                let trimmed = raw.trim();
                if trimmed.is_empty() || trimmed.starts_with('!') {
                    continue;
                }
                dep_set.insert(normalize_identifier(trimmed));
            }
        }
    }
    let fallback_dependencies: Vec<String> = dep_set.into_iter().collect();
    Ok(DiscoveredProject {
        id,
        root: root.to_owned(),
        tags,
        targets,
        fallback_dependencies,
    })
}

fn parent_posix(rel_file: &str) -> String {
    match rel_file.rsplit_once('/') {
        Some((parent, _)) if !parent.is_empty() => parent.to_owned(),
        _ => ".".to_owned(),
    }
}

fn normalize_identifier(raw: &str) -> String {
    let trimmed = raw.trim().trim_start_matches('@');
    let mut out = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    if out.is_empty() {
        "project".to_owned()
    } else {
        out
    }
}

fn read_string_set(value: Option<&Value>) -> BTreeSet<String> {
    value
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn read_object_keys(value: Option<&Value>) -> BTreeSet<String> {
    value
        .and_then(Value::as_object)
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default()
}

/// Strips `//` line comments, `/* ... */` block comments, and trailing commas outside string
/// literals so JSONC `project.json` files parse cleanly.
fn strip_jsonc(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut no_comments = String::with_capacity(input.len());
    let mut i = 0;
    let mut in_string = false;
    while i < chars.len() {
        let ch = chars[i];
        if in_string {
            no_comments.push(ch);
            if ch == '\\' && i + 1 < chars.len() {
                no_comments.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if ch == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if ch == '"' {
            in_string = true;
            no_comments.push('"');
            i += 1;
        } else if ch == '/' && i + 1 < chars.len() && chars[i + 1] == '/' {
            i += 2;
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if ch == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(chars.len());
        } else {
            no_comments.push(ch);
            i += 1;
        }
    }
    strip_trailing_commas(&no_comments)
}

fn strip_trailing_commas(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut in_string = false;
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if in_string {
            out.push(ch);
            if ch == '\\' && i + 1 < chars.len() {
                out.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if ch == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if ch == '"' {
            in_string = true;
            out.push(ch);
            i += 1;
            continue;
        }
        if ch == ',' {
            let mut look = i + 1;
            while look < chars.len() && chars[look].is_whitespace() {
                look += 1;
            }
            if look < chars.len() && matches!(chars[look], '}' | ']') {
                i += 1;
                continue;
            }
        }
        out.push(ch);
        i += 1;
    }
    out
}
