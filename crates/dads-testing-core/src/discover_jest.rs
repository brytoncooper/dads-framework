//! Static Jest config inspection for declarative `workspace.discover` templates.
//!
//! Reads `jest.config.{ts,mts,cts,js,mjs,cjs,json}` without executing user code, extracts
//! statically verifiable `setupFiles` and `setupFilesAfterEnv`, and fails closed whenever either
//! uses a non-literal expression.

use crate::discover_vitest_tiers::INTEGRATION_TIER_SUFFIXES;
use crate::manifest::{FileNarrowing, TaskExecution};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

pub(crate) const JEST_CONFIG_CANDIDATES: &[&str] = &[
    "jest.config.ts",
    "jest.config.mts",
    "jest.config.cts",
    "jest.config.js",
    "jest.config.mjs",
    "jest.config.cjs",
    "jest.config.json",
];

struct JestInspection {
    config_path: Option<String>,
    setup_files: Vec<String>,
    dynamic_setup_files: bool,
}

/// Inspects a project's Jest config to wire static `setupFiles`/`setupFilesAfterEnv` into
/// `fileNarrowing` and record the config file in `impact.paths`. Fails closed on dynamic setup
/// expressions, and is a no-op when no project-local Jest config is present.
pub(crate) fn apply_auto_jest_narrowing(
    workspace_root: &Path,
    project_root: &str,
    execution: &mut TaskExecution,
    impact_paths: &mut Vec<String>,
    exclude_integration_tiers: bool,
) {
    let inspection = inspect_project_jest_config(workspace_root, project_root);
    let Some(config_path) = inspection.config_path else {
        return;
    };
    if !impact_paths.contains(&config_path) {
        impact_paths.push(config_path);
        impact_paths.sort();
    }
    if inspection.dynamic_setup_files {
        execution.file_narrowing = None;
        return;
    }
    let default_suffixes = vec![
        ".test.ts".to_owned(),
        ".test.tsx".to_owned(),
        ".spec.ts".to_owned(),
        ".spec.tsx".to_owned(),
        ".test.js".to_owned(),
        ".test.jsx".to_owned(),
        ".spec.js".to_owned(),
        ".spec.jsx".to_owned(),
    ];
    let default_excludes = if exclude_integration_tiers {
        INTEGRATION_TIER_SUFFIXES
            .iter()
            .map(|s| (*s).to_owned())
            .collect()
    } else {
        Vec::new()
    };
    let existing = execution.file_narrowing.take();
    let (suffixes, exclude_suffixes, mut setup_set) = match existing {
        Some(n) => (
            if n.suffixes.is_empty() {
                default_suffixes
            } else {
                n.suffixes
            },
            if n.exclude_suffixes.is_empty() {
                default_excludes
            } else {
                n.exclude_suffixes
            },
            n.setup_files.into_iter().collect::<BTreeSet<_>>(),
        ),
        None => (default_suffixes, default_excludes, BTreeSet::new()),
    };
    setup_set.extend(inspection.setup_files);
    execution.file_narrowing = Some(FileNarrowing {
        suffixes,
        exclude_suffixes,
        setup_files: setup_set.into_iter().collect(),
    });
}

fn inspect_project_jest_config(workspace_root: &Path, project_root: &str) -> JestInspection {
    let Some(rel_config) = find_jest_config(workspace_root, project_root) else {
        return JestInspection {
            config_path: None,
            setup_files: Vec::new(),
            dynamic_setup_files: false,
        };
    };
    let Ok(source) = fs::read_to_string(workspace_root.join(&rel_config)) else {
        return JestInspection {
            config_path: Some(rel_config),
            setup_files: Vec::new(),
            dynamic_setup_files: true,
        };
    };
    let (setup_files, dynamic_setup_files) = if rel_config.ends_with(".json") {
        extract_json_setup_files(&source, project_root)
    } else {
        extract_js_setup_files(&source, project_root)
    };
    JestInspection {
        config_path: Some(rel_config),
        setup_files,
        dynamic_setup_files,
    }
}

pub(crate) fn has_project_jest_config(workspace_root: &Path, project_root: &str) -> bool {
    find_jest_config(workspace_root, project_root).is_some()
}

fn find_jest_config(workspace_root: &Path, project_root: &str) -> Option<String> {
    let dir = if project_root == "." || project_root.is_empty() {
        workspace_root.to_path_buf()
    } else {
        workspace_root.join(project_root)
    };
    for candidate in JEST_CONFIG_CANDIDATES {
        if dir.join(candidate).is_file() {
            return Some(if project_root == "." || project_root.is_empty() {
                (*candidate).to_owned()
            } else {
                format!("{project_root}/{candidate}")
            });
        }
    }
    None
}

fn extract_json_setup_files(raw: &str, project_root: &str) -> (Vec<String>, bool) {
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(raw) else {
        return (Vec::new(), true);
    };
    let mut out = BTreeSet::new();
    for key in ["setupFiles", "setupFilesAfterEnv"] {
        let Some(val) = map.get(key) else {
            continue;
        };
        let Some(arr) = val.as_array() else {
            return (Vec::new(), true);
        };
        for item in arr {
            let Some(s) = item.as_str() else {
                return (Vec::new(), true);
            };
            if let Some(norm) = normalize_jest_setup_path(s, project_root) {
                out.insert(norm);
            }
        }
    }
    (out.into_iter().collect(), false)
}

fn extract_js_setup_files(source: &str, project_root: &str) -> (Vec<String>, bool) {
    let mut out = BTreeSet::new();
    for key in ["setupFilesAfterEnv", "setupFiles"] {
        let mut cursor = source;
        while let Some(pos) = cursor.find(key) {
            let after_key = &cursor[pos + key.len()..];
            let preceded_by_ident = pos > 0 && cursor.as_bytes()[pos - 1].is_ascii_alphanumeric();
            cursor = after_key;
            if preceded_by_ident {
                continue;
            }
            let trimmed = after_key.trim_start();
            let Some(after_colon) = trimmed.strip_prefix(':') else {
                continue;
            };
            let val_start = after_colon.trim_start();
            let Some(after_bracket) = val_start.strip_prefix('[') else {
                return (Vec::new(), true);
            };
            let Some(end_bracket) = after_bracket.find(']') else {
                return (Vec::new(), true);
            };
            let inner = &after_bracket[..end_bracket];
            if !parse_string_literal_list(inner, project_root, &mut out) {
                return (Vec::new(), true);
            }
        }
    }
    (out.into_iter().collect(), false)
}

fn parse_string_literal_list(inner: &str, project_root: &str, out: &mut BTreeSet<String>) -> bool {
    let mut rest = inner.trim();
    while !rest.is_empty() {
        let bytes = rest.as_bytes();
        let quote = bytes[0];
        if quote != b'\'' && quote != b'"' {
            return false;
        }
        let Some(end) = rest[1..].find(quote as char) else {
            return false;
        };
        let literal = &rest[1..1 + end];
        if let Some(norm) = normalize_jest_setup_path(literal, project_root) {
            out.insert(norm);
        }
        rest = rest[2 + end..].trim_start();
        if let Some(after_comma) = rest.strip_prefix(',') {
            rest = after_comma.trim_start();
        } else if !rest.is_empty() {
            return false;
        }
    }
    true
}

fn normalize_jest_setup_path(raw: &str, project_root: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let rel = trimmed
        .strip_prefix("<rootDir>/")
        .or_else(|| trimmed.strip_prefix("./"))
        .unwrap_or(trimmed);
    if rel.starts_with('/') || rel.contains('<') {
        return None;
    }
    if project_root == "." || project_root.is_empty() {
        Some(rel.to_owned())
    } else {
        Some(format!("{project_root}/{rel}"))
    }
}
