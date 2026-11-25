//! Synthetic `fs-dir:` directory-watch seeding and Option 3 `unresolved-fs-read` widening.

use super::PlanEvidence;
use crate::graph::DependencyGraph;
use crate::manifest::TestingManifest;
use crate::protocol::{IssueScope, IssueSeverity, PlanIssue, ResolvedScope};
use crate::scope::{deepest_project_for_path, path_matches_impact};
use std::collections::BTreeSet;

pub(crate) const FS_DIR_PREFIX: &str = "fs-dir:";

pub(super) fn collect_graph_changed_paths(
    manifest: &TestingManifest,
    scope: &ResolvedScope,
    graph: Option<&DependencyGraph>,
    evidence: &PlanEvidence<'_>,
) -> Vec<String> {
    let mut changed_paths: Vec<String> = scope
        .changed_paths
        .iter()
        .filter(|path| {
            !manifest
                .workspace
                .ignore_paths
                .iter()
                .any(|pattern| path_matches_impact(path, pattern))
        })
        .filter(|path| {
            !manifest
                .workspace
                .non_code_suffixes
                .iter()
                .any(|suffix| path.ends_with(suffix))
        })
        .filter(|path| !evidence.lockfile_handled_paths.contains(*path))
        .filter(|path| !evidence.tsconfig_handled_paths.contains(*path))
        .filter(|path| {
            !evidence.sql_handled_paths.contains(*path)
                || graph.is_some_and(|g| g.contains_path(path))
        })
        .cloned()
        .collect();
    for seeded in evidence
        .lockfile_seeded_modules
        .iter()
        .chain(&evidence.tsconfig_seeded_modules)
    {
        if !changed_paths.contains(seeded) {
            changed_paths.push(seeded.clone());
        }
    }
    changed_paths
}

pub(super) fn record_fs_dir_reachable_path<'a>(
    manifest: &'a TestingManifest,
    path: &str,
    evidence: &mut PlanEvidence<'a>,
    for_runtime_tests: bool,
) -> bool {
    let Some(dir) = path.strip_prefix(FS_DIR_PREFIX) else {
        return false;
    };
    if let Some(project) = deepest_project_for_path(&manifest.projects, dir) {
        if for_runtime_tests {
            evidence
                .reachability_impacted_projects
                .insert(project.id.as_str());
        } else {
            evidence
                .typecheck_reachability_impacted_projects
                .insert(project.id.as_str());
        }
    }
    true
}

/// Collects every synthetic `fs-dir:<ancestor>` directory watch in `graph` that encloses any path
/// in `changed_paths`.
pub(super) fn matching_fs_dir_nodes(
    graph: &DependencyGraph,
    changed_paths: &[String],
) -> Vec<String> {
    let mut matched = BTreeSet::new();
    for path in changed_paths {
        let mut cursor = path.as_str();
        while let Some((parent, _)) = cursor.rsplit_once('/') {
            let key = format!("{FS_DIR_PREFIX}{parent}");
            if graph.contains_path(&key) {
                matched.insert(key);
            }
            cursor = parent;
        }
    }
    matched.into_iter().collect()
}

/// When an uncovered non-JS path changed and `--enforce-declared-reads` is off, any module with an
/// `unresolved-fs-read` uncertainty (and its reverse importers) could have read that file at
/// runtime, so widen its owning project(s) conservatively.
pub(super) fn widen_unresolved_fs_readers<'a>(
    manifest: &'a TestingManifest,
    graph: &DependencyGraph,
    evidence: &mut PlanEvidence<'a>,
    has_non_test_reachability: bool,
) {
    let unresolved: Vec<_> = graph
        .uncertainties()
        .into_iter()
        .filter(|u| {
            u.code == "unresolved-fs-read"
                && !manifest
                    .workspace
                    .dynamic_import_scopes
                    .contains_key(&u.path)
        })
        .collect();
    if unresolved.is_empty() {
        return;
    }
    let seeds: Vec<String> = unresolved.iter().map(|u| u.path.clone()).collect();
    let reached = graph.reachability_from(seeds);
    for reached_path in &reached.paths {
        let Some(project) = deepest_project_for_path(&manifest.projects, reached_path) else {
            continue;
        };
        let id = project.id.as_str();
        evidence.reachability_impacted_projects.insert(id);
        evidence.uncertainty_impacted_projects.insert(id);
        if has_non_test_reachability {
            evidence.typecheck_reachability_impacted_projects.insert(id);
            evidence.typecheck_uncertainty_impacted_projects.insert(id);
        }
        let issue_index = evidence.issues.len();
        evidence
            .issue_indexes_by_project
            .entry(id)
            .or_default()
            .push(issue_index);
        evidence.issues.push(PlanIssue {
            path: Some(reached_path.clone()),
            project: Some(project.id.clone()),
            ..PlanIssue::new(
                "unresolved-fs-read",
                format!(
                    "{reached_path} depends on an unresolved dynamic filesystem read while uncovered files changed; widened conservatively (enable --enforce-declared-reads to verify at runtime)."
                ),
                IssueSeverity::Uncertainty,
                IssueScope::Module,
            )
        });
    }
}
