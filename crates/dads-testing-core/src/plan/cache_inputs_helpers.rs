//! Helper routines for `cache_inputs`: closure-breaking uncertainty classification, seed module
//! collection, project dependency root expansion, and SQL snapshot glob construction.

use crate::graph::GraphUncertainty;
use crate::manifest::Project;
use crate::protocol::TaskCacheInputs;
use crate::scope::path_matches_impact;
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

pub(super) fn is_ignored_path(path: &str, ignore_paths: &[String]) -> bool {
    ignore_paths
        .iter()
        .any(|pattern| path_matches_impact(path, pattern))
}

pub(super) fn uncacheable_inputs() -> TaskCacheInputs {
    TaskCacheInputs {
        cacheable: false,
        project_roots: Vec::new(),
        impact_paths: Vec::new(),
        extra_files: Vec::new(),
    }
}

pub(super) fn is_closure_breaking_uncertainty(
    uncertainty: &GraphUncertainty,
    dynamic_import_scopes: &BTreeMap<String, Vec<String>>,
    enforce_declared_reads: bool,
) -> bool {
    match uncertainty.code.as_str() {
        "unresolved-local-module"
        | "generated-or-virtual-module"
        | "javascript-parse-failed"
        | "javascript-semantic-failed"
        | "javascript-source-read-failed" => true,
        "nonliteral-dynamic-import" | "nonliteral-commonjs-require" => {
            !dynamic_import_scopes.contains_key(&uncertainty.path)
        }
        "unresolved-fs-read" => {
            !enforce_declared_reads && !dynamic_import_scopes.contains_key(&uncertainty.path)
        }
        _ => false,
    }
}

pub(super) fn collect_seed_modules(
    node_by_path: &HashMap<&str, usize>,
    nodes_by_project: &BTreeMap<&str, Vec<usize>>,
    project_id: &str,
    selected_files: &[String],
    setup_files: &[String],
) -> (Vec<usize>, bool) {
    if !selected_files.is_empty() {
        let mut seeds = Vec::with_capacity(selected_files.len() + setup_files.len());
        let mut all_present = true;
        for path in selected_files.iter().chain(setup_files.iter()) {
            if let Some(&idx) = node_by_path.get(path.as_str()) {
                seeds.push(idx);
            } else {
                all_present = false;
            }
        }
        if all_present {
            return (seeds, false);
        }
        if let Some(project_nodes) = nodes_by_project.get(project_id) {
            seeds.extend(project_nodes.iter().copied());
        }
        return (seeds, true);
    }
    let mut seeds = nodes_by_project
        .get(project_id)
        .cloned()
        .unwrap_or_default();
    for path in setup_files {
        if let Some(&idx) = node_by_path.get(path.as_str()) {
            seeds.push(idx);
        }
    }
    (seeds, true)
}

pub(super) fn expand_project_dependency_roots<'a>(
    projects_by_id: &BTreeMap<&'a str, &'a Project>,
    unified_project_deps: &BTreeMap<&'a str, BTreeSet<&'a str>>,
    seed_projects: &BTreeSet<&'a str>,
    owner_project: &'a str,
    expand_owner_via_unified: bool,
) -> Option<BTreeSet<String>> {
    let mut visited = BTreeSet::new();
    let mut queue = VecDeque::new();
    let mut roots = BTreeSet::new();
    for &project_id in seed_projects {
        if visited.insert(project_id) {
            queue.push_back((project_id, false));
        }
    }
    while let Some((project_id, reached_via_fallback)) = queue.pop_front() {
        let project = projects_by_id.get(project_id)?;
        roots.insert(project.root.clone());
        for dep in &project.fallback_dependencies {
            if visited.insert(dep.as_str()) {
                queue.push_back((dep.as_str(), true));
            }
        }
        // If a project was pulled in via `fallbackDependencies` (not Oxc module traversal),
        // also include its Oxc dependencies so indirect `fallback -> Oxc` chains never go stale.
        let use_unified =
            reached_via_fallback || (expand_owner_via_unified && project_id == owner_project);
        if use_unified && let Some(deps) = unified_project_deps.get(project_id) {
            for &dep in deps {
                if visited.insert(dep) {
                    queue.push_back((dep, true));
                }
            }
        }
    }
    Some(roots)
}

pub(crate) fn snapshot_pattern_globs(prefix: &str, suffix: &str) -> Vec<String> {
    if prefix.ends_with('/') {
        if suffix.starts_with('/') {
            vec![format!("{prefix}**{suffix}")]
        } else {
            vec![format!("{prefix}**/*{suffix}")]
        }
    } else if suffix.starts_with('/') {
        vec![
            format!("{prefix}*{suffix}"),
            format!("{prefix}*/**{suffix}"),
        ]
    } else {
        vec![
            format!("{prefix}*{suffix}"),
            format!("{prefix}*/**/*{suffix}"),
        ]
    }
}
