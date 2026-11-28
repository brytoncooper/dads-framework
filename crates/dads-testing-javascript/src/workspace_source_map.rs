//! Maps bare workspace package imports (e.g. `@scope/pkg`, `@scope/pkg/subpath`) whose
//! `package.json` `exports`/`main`/`module` point into compiled output directories (`dist/`,
//! `build/`, `out/`) back to their real TypeScript/JavaScript source entrypoints (`src/...`).
//!
//! If no concrete source file exists for a workspace package specifier, returns `None` so the
//! caller emits `unresolved-bare-module` and fails closed.

use dads_testing_core::graph::external_package_name;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::workspace::{is_javascript_path, workspace_relative_path};

const COMPILED_DIR_PREFIXES: &[&str] = &["dist/", "build/", "out/", "esm/", "cjs/", "lib/"];
const SOURCE_EXTENSIONS: &[&str] = &["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];
const EXPORT_CONDITIONS: &[&str] = &["import", "default", "module", "node", "require", "types"];

#[derive(Debug, Default)]
struct WorkspacePackageEntry {
    dir: String,
    exports: HashMap<String, String>,
    main: Option<String>,
}

#[derive(Debug, Default)]
pub(crate) struct WorkspaceSourceMap {
    packages: HashMap<String, WorkspacePackageEntry>,
    canonical_root: Option<PathBuf>,
}

impl WorkspaceSourceMap {
    pub(crate) fn build(
        workspace_root: &Path,
        canonical_root: Option<&Path>,
        workspace_files: &[String],
    ) -> Self {
        let mut map = Self {
            packages: HashMap::new(),
            canonical_root: canonical_root.map(Path::to_path_buf),
        };
        for rel in workspace_files {
            if rel == "package.json" || rel.ends_with("/package.json") {
                map.ingest_package_json(workspace_root, rel);
            }
        }
        map
    }

    pub(crate) fn resolve_specifier(&self, specifier: &str) -> Option<String> {
        let canonical_root = self.canonical_root.as_deref()?;
        let pkg_name = external_package_name(specifier)?;
        let entry = self.packages.get(pkg_name)?;
        let subpath = match specifier.strip_prefix(pkg_name) {
            Some("") | None => ".".to_owned(),
            Some(rest) if rest.starts_with('/') => format!(".{rest}"),
            _ => return None,
        };
        let target = lookup_export_target(entry, &subpath)?;
        map_target_to_source(canonical_root, &entry.dir, &target)
    }

    fn ingest_package_json(&mut self, workspace_root: &Path, rel: &str) {
        let Ok(raw) = fs::read_to_string(workspace_root.join(rel)) else {
            return;
        };
        let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(&raw) else {
            return;
        };
        let Some(name) = obj
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            return;
        };
        let dir = rel
            .rsplit_once('/')
            .map(|(parent, _)| parent.to_owned())
            .unwrap_or_default();
        let mut exports = HashMap::new();
        if let Some(exp) = obj.get("exports") {
            collect_exports(exp, &mut exports);
        }
        let main = obj
            .get("module")
            .or_else(|| obj.get("main"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        self.packages.insert(
            name.to_owned(),
            WorkspacePackageEntry { dir, exports, main },
        );
    }
}

pub(crate) fn path_is_in_compiled_output(rel: &str) -> bool {
    rel.split('/')
        .any(|seg| matches!(seg, "dist" | "build" | "out"))
}

/// Maps local re-export stubs (e.g. `internal.d.ts` -> `./dist/internal` or `../dist/anthropic`)
/// to their real TypeScript source when `dist/` has not been compiled yet.
pub(crate) fn resolve_local_compiled_output_to_source(
    workspace_root: &Path,
    absolute_path: &Path,
    specifier: &str,
) -> Option<String> {
    let canonical_root = workspace_root.canonicalize().ok()?;
    let joined = absolute_path.parent()?.join(specifier);
    let mut parts: Vec<std::ffi::OsString> = Vec::new();
    for comp in joined.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                parts.pop();
            }
            std::path::Component::Normal(s) => parts.push(s.to_os_string()),
            std::path::Component::RootDir => parts.push(std::ffi::OsString::from("/")),
            std::path::Component::Prefix(p) => parts.push(p.as_os_str().to_os_string()),
        }
    }
    let normalized: PathBuf = parts.iter().collect();
    let rel = normalized.strip_prefix(&canonical_root).ok()?;
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    let segments: Vec<&str> = rel_str.split('/').collect();
    let idx = segments
        .iter()
        .position(|s| matches!(*s, "dist" | "build" | "out"))?;
    let pkg_dir = segments[..idx].join("/");
    let tail = segments[idx + 1..].join("/");
    if tail.is_empty() {
        return None;
    }
    map_target_to_source(&canonical_root, &pkg_dir, &format!("dist/{tail}"))
}

fn collect_exports(value: &Value, out: &mut HashMap<String, String>) {
    match value {
        Value::String(s) => {
            out.insert(".".to_owned(), s.clone());
        }
        Value::Object(map) => {
            let has_subpath_keys = map.keys().any(|k| k.starts_with('.'));
            if has_subpath_keys {
                for (key, val) in map {
                    if key.starts_with('.')
                        && let Some(target) = extract_condition_target(val)
                    {
                        out.insert(key.clone(), target);
                    }
                }
            } else if let Some(target) = extract_condition_target(value) {
                out.insert(".".to_owned(), target);
            }
        }
        _ => {}
    }
}

fn extract_condition_target(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => items.iter().find_map(extract_condition_target),
        Value::Object(map) => {
            for cond in EXPORT_CONDITIONS {
                if let Some(v) = map.get(*cond)
                    && let Some(found) = extract_condition_target(v)
                {
                    return Some(found);
                }
            }
            map.values().find_map(extract_condition_target)
        }
        _ => None,
    }
}

fn lookup_export_target(entry: &WorkspacePackageEntry, subpath: &str) -> Option<String> {
    if let Some(exact) = entry.exports.get(subpath) {
        return Some(exact.clone());
    }
    for (pattern, target) in &entry.exports {
        if let Some((prefix, suffix)) = pattern.split_once('*')
            && subpath.starts_with(prefix)
            && subpath.ends_with(suffix)
            && subpath.len() >= prefix.len() + suffix.len()
        {
            let matched = &subpath[prefix.len()..subpath.len() - suffix.len()];
            return Some(target.replacen('*', matched, 1));
        }
    }
    if subpath == "." {
        return entry.main.clone();
    }
    None
}

fn map_target_to_source(canonical_root: &Path, pkg_dir: &str, raw_target: &str) -> Option<String> {
    let trimmed = raw_target.trim_start_matches("./");
    let pkg_base = if pkg_dir.is_empty() {
        canonical_root.to_path_buf()
    } else {
        canonical_root.join(pkg_dir)
    };
    if !path_is_in_compiled_output(trimmed)
        && let Some(found) = check_existing_source(canonical_root, &pkg_base.join(trimmed))
    {
        return Some(found);
    }
    let stripped = COMPILED_DIR_PREFIXES
        .iter()
        .find_map(|prefix| trimmed.strip_prefix(prefix))
        .unwrap_or(trimmed);
    let stem = strip_js_or_dts_extension(stripped);
    for candidate_rel in [
        format!("src/{stem}"),
        format!("src/{stem}/index"),
        stem.to_owned(),
        format!("{stem}/index"),
    ] {
        for ext in SOURCE_EXTENSIONS {
            let candidate = pkg_base.join(format!("{candidate_rel}.{ext}"));
            if let Some(found) = check_existing_source(canonical_root, &candidate) {
                return Some(found);
            }
        }
    }
    None
}

fn strip_js_or_dts_extension(path: &str) -> &str {
    for suffix in [
        ".d.ts", ".d.mts", ".d.cts", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx",
    ] {
        if let Some(stem) = path.strip_suffix(suffix) {
            return stem;
        }
    }
    path
}

fn check_existing_source(canonical_root: &Path, candidate: &Path) -> Option<String> {
    if !candidate.is_file() {
        return None;
    }
    let canonical = candidate.canonicalize().ok()?;
    if !canonical.starts_with(canonical_root) || !is_javascript_path(&canonical) {
        return None;
    }
    let rel = workspace_relative_path(canonical_root, &canonical)?;
    if rel
        .split('/')
        .any(|seg| matches!(seg, "node_modules" | ".git"))
    {
        return None;
    }
    Some(rel)
}
