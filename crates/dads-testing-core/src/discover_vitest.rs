//! Static Vitest config inspection for declarative `workspace.discover` templates.
//!
//! Reads `vitest.config.{ts,mts,js,mjs}` (or `vite.config.*`) without executing user code,
//! extracts statically verifiable `setupFiles`, and fails closed (`dynamic_setup_files = true`)
//! whenever `setupFiles` uses a non-literal expression.

use crate::manifest::{FileNarrowing, ImpactMode, TaskExecution, TaskKind, TestingManifest};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

pub(crate) const VITEST_CONFIG_CANDIDATES: &[&str] = &[
    "vitest.config.ts",
    "vitest.config.mts",
    "vitest.config.js",
    "vitest.config.mjs",
    "vite.config.ts",
    "vite.config.mts",
    "vite.config.js",
    "vite.config.mjs",
];

pub(crate) struct VitestDiscovery {
    pub(crate) config_path: Option<String>,
    pub(crate) setup_files: Vec<String>,
    pub(crate) dynamic_setup_files: bool,
}

/// Ensures discovered Vitest commands always run non-interactively (`vitest run`) instead of
/// entering watch mode when `CI` is unset.
pub(crate) fn normalize_vitest_run_args(execution: &mut TaskExecution) {
    let non_run_subcommands = [
        "run",
        "bench",
        "list",
        "init",
        "--run",
        "--version",
        "-v",
        "--help",
        "-h",
    ];
    let is_direct = execution.executable == "vitest" || execution.executable.ends_with("/vitest");
    if is_direct {
        if !execution
            .args
            .iter()
            .any(|arg| non_run_subcommands.contains(&arg.as_str()))
        {
            execution.args.insert(0, "run".to_owned());
        }
        return;
    }
    if execution.executable == "npx"
        && execution.args.first().map(String::as_str) == Some("vitest")
        && !execution.args[1..]
            .iter()
            .any(|arg| non_run_subcommands.contains(&arg.as_str()))
    {
        execution.args.insert(1, "run".to_owned());
    }
}

/// Inspects a project's Vitest config to wire static `setupFiles` into `fileNarrowing` and record
/// the config file in `impact.paths`. Fails closed (omits `fileNarrowing`) on dynamic `setupFiles`.
/// When `exclude_integration_tiers` is true (dual-tier projects with `test:integration` or
/// `test:e2e`), automatically excludes `.integration.test.*` and `.e2e.test.*` from unit narrowing.
pub(crate) fn apply_auto_vitest_narrowing(
    workspace_root: &Path,
    project_root: &str,
    execution: &mut TaskExecution,
    impact_paths: &mut Vec<String>,
    exclude_integration_tiers: bool,
) {
    let inspection = inspect_project_vitest_config(workspace_root, project_root);
    if let Some(config_path) = inspection.config_path
        && !impact_paths.contains(&config_path)
    {
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
    ];
    let default_excludes = if exclude_integration_tiers {
        vec![
            ".integration.test.ts".to_owned(),
            ".integration.test.tsx".to_owned(),
            ".e2e.test.ts".to_owned(),
            ".e2e.test.tsx".to_owned(),
        ]
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

pub(crate) fn inspect_project_vitest_config(
    workspace_root: &Path,
    project_root: &str,
) -> VitestDiscovery {
    let config_path = find_vitest_config(workspace_root, project_root);
    let Some(rel_config) = config_path else {
        return VitestDiscovery {
            config_path: None,
            setup_files: Vec::new(),
            dynamic_setup_files: false,
        };
    };
    let Ok(source) = fs::read_to_string(workspace_root.join(&rel_config)) else {
        return VitestDiscovery {
            config_path: Some(rel_config),
            setup_files: Vec::new(),
            dynamic_setup_files: true,
        };
    };
    let (setup_files, dynamic_setup_files) = extract_static_setup_files(&source, project_root);
    VitestDiscovery {
        config_path: Some(rel_config),
        setup_files,
        dynamic_setup_files,
    }
}

fn find_vitest_config(workspace_root: &Path, project_root: &str) -> Option<String> {
    for name in VITEST_CONFIG_CANDIDATES {
        let rel = if project_root == "." {
            (*name).to_owned()
        } else {
            format!("{project_root}/{name}")
        };
        if workspace_root.join(&rel).is_file() {
            return Some(rel);
        }
    }
    None
}

fn extract_static_setup_files(source: &str, project_root: &str) -> (Vec<String>, bool) {
    let Some(colon_idx) = find_setup_files_colon(source) else {
        return (Vec::new(), false);
    };
    let rest = source[colon_idx + 1..].trim_start();
    if let Some((literal, _)) = parse_quoted_string(rest) {
        return match resolve_setup_path(project_root, literal) {
            Some(path) => (vec![path], false),
            None => (Vec::new(), true),
        };
    }
    if let Some(after_bracket) = rest.strip_prefix('[') {
        let Some(end_bracket) = after_bracket.find(']') else {
            return (Vec::new(), true);
        };
        return parse_setup_array(&after_bracket[..end_bracket], project_root);
    }
    (Vec::new(), true)
}

fn find_setup_files_colon(source: &str) -> Option<usize> {
    let needle = "setupFiles";
    let mut search_from = 0;
    while let Some(rel) = source[search_from..].find(needle) {
        let start = search_from + rel;
        let prev_ok = start == 0
            || !source[..start]
                .chars()
                .next_back()
                .is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_');
        let after = start + needle.len();
        if prev_ok {
            let trimmed = source[after..].trim_start();
            if trimmed.starts_with(':') {
                let offset = source[after..].len() - trimmed.len();
                return Some(after + offset);
            }
        }
        search_from = after;
    }
    None
}

fn parse_setup_array(body: &str, project_root: &str) -> (Vec<String>, bool) {
    let mut paths = BTreeSet::new();
    let mut cursor = body.trim();
    while !cursor.is_empty() {
        let Some((literal, remaining)) = parse_quoted_string(cursor) else {
            return (Vec::new(), true);
        };
        let Some(resolved) = resolve_setup_path(project_root, literal) else {
            return (Vec::new(), true);
        };
        paths.insert(resolved);
        cursor = remaining.trim_start();
        if let Some(after_comma) = cursor.strip_prefix(',') {
            cursor = after_comma.trim_start();
        } else if !cursor.is_empty() {
            return (Vec::new(), true);
        }
    }
    (paths.into_iter().collect(), false)
}

fn parse_quoted_string(input: &str) -> Option<(&str, &str)> {
    let quote = input.chars().next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }
    let rest = &input[1..];
    let end = rest.find(quote)?;
    let literal = &rest[..end];
    if literal.contains('\n') || literal.contains('\r') {
        return None;
    }
    Some((literal, &rest[end + 1..]))
}

fn resolve_setup_path(project_root: &str, entry: &str) -> Option<String> {
    if entry.is_empty() || entry.starts_with('/') || entry.contains("${") || entry.contains('*') {
        return None;
    }
    let raw = if project_root == "." {
        entry.to_owned()
    } else {
        format!("{project_root}/{entry}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for segment in raw.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

/// Hydrates project-level `vitest.config.*` / `vite.config.*` `setupFiles` and config paths onto
/// static manifest `reachability` test tasks so editing a config-declared setup file invalidates
/// planning and caching even when it is not duplicated in `dads.testing.json`.
pub(crate) fn hydrate_static_vitest_setup_files(
    manifest: &mut TestingManifest,
    workspace_root: &Path,
) {
    let project_roots: BTreeMap<String, String> = manifest
        .projects
        .iter()
        .map(|project| (project.id.clone(), project.root.clone()))
        .collect();
    let mut cache: BTreeMap<String, VitestDiscovery> = BTreeMap::new();
    for task in &mut manifest.tasks {
        if task.kind != TaskKind::Test || task.impact.mode != ImpactMode::Reachability {
            continue;
        }
        let Some(project_root) = project_roots.get(&task.project) else {
            continue;
        };
        let inspection = cache
            .entry(project_root.clone())
            .or_insert_with(|| inspect_project_vitest_config(workspace_root, project_root));
        if let Some(config_path) = &inspection.config_path
            && !task.impact.paths.contains(config_path)
        {
            task.impact.paths.push(config_path.clone());
            task.impact.paths.sort();
        }
        if inspection.dynamic_setup_files {
            task.execution.file_narrowing = None;
            continue;
        }
        if inspection.setup_files.is_empty() {
            continue;
        }
        if let Some(narrowing) = &mut task.execution.file_narrowing {
            for setup in &inspection.setup_files {
                if !narrowing.setup_files.contains(setup) {
                    narrowing.setup_files.push(setup.clone());
                }
            }
            narrowing.setup_files.sort();
        } else {
            for setup in &inspection.setup_files {
                if !task.impact.paths.contains(setup) {
                    task.impact.paths.push(setup.clone());
                }
            }
            task.impact.paths.sort();
        }
    }
}
