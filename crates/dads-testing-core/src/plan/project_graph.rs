//! Unified project dependency graph combining declared `fallbackDependencies` with resolved
//! cross-project module import edges from the language frontend.

use crate::graph::{ImportKind, ModuleNode};
use crate::manifest::TestingManifest;
use crate::scope::{deepest_project_for_path, path_matches_impact};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// Computes `project_id -> direct dependency project_ids` as the union of:
/// - Every declared `project.fallback_dependencies` edge, and
/// - Every resolved cross-project import edge in `nodes` (`owner(module) -> owner(resolved_path)`
///   where the two owning projects differ).
///
/// Including both runtime and type-only resolved edges is conservative and sound for both runtime
/// test widening and typecheck widening.
pub(crate) fn unified_project_dependencies<'a>(
    manifest: &'a TestingManifest,
    nodes: &[ModuleNode],
) -> BTreeMap<&'a str, BTreeSet<&'a str>> {
    let known_projects: HashMap<&'a str, &'a str> = manifest
        .projects
        .iter()
        .map(|project| (project.id.as_str(), project.id.as_str()))
        .collect();
    let mut deps: BTreeMap<&'a str, BTreeSet<&'a str>> = BTreeMap::new();
    for project in &manifest.projects {
        let entry = deps.entry(project.id.as_str()).or_default();
        for dep in &project.fallback_dependencies {
            if let Some(&dep_id) = known_projects.get(dep.as_str())
                && dep_id != project.id.as_str()
            {
                entry.insert(dep_id);
            }
        }
    }
    if nodes.is_empty() {
        return deps;
    }
    let is_ignored = |path: &str| {
        manifest
            .workspace
            .ignore_paths
            .iter()
            .any(|pattern| path_matches_impact(path, pattern))
    };
    let mut owner_by_path: HashMap<&str, &'a str> = HashMap::with_capacity(nodes.len());
    for node in nodes {
        if is_ignored(&node.path) {
            continue;
        }
        if let Some(project) = deepest_project_for_path(&manifest.projects, &node.path) {
            owner_by_path.insert(node.path.as_str(), project.id.as_str());
        }
    }
    for node in nodes {
        let Some(&proj_a) = owner_by_path.get(node.path.as_str()) else {
            continue;
        };
        let entry = deps.entry(proj_a).or_default();
        for imp in &node.imports {
            if imp.kind == ImportKind::FileRead {
                continue;
            }
            let Some(target_path) = imp.resolved_path.as_deref() else {
                continue;
            };
            if is_ignored(target_path) {
                continue;
            }
            let proj_b = owner_by_path.get(target_path).copied().or_else(|| {
                deepest_project_for_path(&manifest.projects, target_path).map(|p| p.id.as_str())
            });
            if let Some(proj_b) = proj_b
                && proj_b != proj_a
            {
                entry.insert(proj_b);
            }
        }
    }
    deps
}
