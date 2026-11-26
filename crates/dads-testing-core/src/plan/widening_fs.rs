//! Synthetic `fs-dir:` directory-watch seeding and Option 3 `unresolved-fs-read` widening.

use super::PlanEvidence;
use crate::graph::DependencyGraph;
use crate::manifest::{ImpactMode, TaskKind, TestingManifest};
use crate::protocol::{IssueScope, IssueSeverity, PlanIssue};
use crate::scope::{deepest_project_for_path, is_isolated_test_file};
use std::collections::BTreeSet;
use std::path::Path;

pub(crate) const FS_DIR_PREFIX: &str = "fs-dir:";

pub(crate) fn is_ambient_dts_path(path: &str) -> bool {
    path.ends_with(".d.ts") || path.ends_with(".d.mts") || path.ends_with(".d.cts")
}

/// Ambient `.d.ts`/`.d.mts`/`.d.cts` files (`declare global`, `declare module`, or ambient types)
/// can break any project's `typecheck` via `tsconfig.json` `include` globs without an explicit
/// `import` edge. Widen only the typecheck channel so runtime `test` tasks stay narrowed.
pub(super) fn widen_ambient_dts_typechecks<'a>(
    manifest: &'a TestingManifest,
    changed_paths: &[String],
    active_paths: Option<&BTreeSet<String>>,
    evidence: &mut PlanEvidence<'a>,
) {
    let dts_paths: Vec<&String> = changed_paths
        .iter()
        .filter(|path| {
            is_ambient_dts_path(path) && active_paths.is_none_or(|active| active.contains(*path))
        })
        .collect();
    if dts_paths.is_empty() {
        return;
    }
    let typecheck_projects: BTreeSet<&'a str> = manifest
        .tasks
        .iter()
        .filter(|task| {
            task.impact.mode == ImpactMode::Reachability && task.kind == TaskKind::Typecheck
        })
        .map(|task| task.project.as_str())
        .collect();
    if typecheck_projects.is_empty() {
        return;
    }
    for dts in dts_paths {
        let issue_index = evidence.issues.len();
        evidence.issues.push(PlanIssue {
            path: Some(dts.clone()),
            project: deepest_project_for_path(&manifest.projects, dts).map(|p| p.id.clone()),
            ..PlanIssue::new(
                "ambient-declaration-typecheck",
                format!(
                    "{dts} is an ambient TypeScript declaration file; widened typecheck tasks conservatively."
                ),
                IssueSeverity::Uncertainty,
                IssueScope::Module,
            )
        });
        for &project_id in &typecheck_projects {
            evidence
                .typecheck_reachability_impacted_projects
                .insert(project_id);
            evidence
                .typecheck_local_uncertainty_impacted_projects
                .insert(project_id);
            evidence
                .issue_indexes_by_project
                .entry(project_id)
                .or_default()
                .push(issue_index);
        }
    }
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
    let seeds: Vec<String> = graph
        .uncertainties()
        .into_iter()
        .filter(|u| {
            u.code == "unresolved-fs-read"
                && !manifest
                    .workspace
                    .dynamic_import_scopes
                    .contains_key(&u.path)
        })
        .map(|u| u.path)
        .collect();
    if seeds.is_empty() {
        return;
    }
    widen_reached_unresolved_projects(
        manifest,
        graph,
        evidence,
        has_non_test_reachability,
        seeds,
        UnresolvedWidenSpec {
            code: "unresolved-fs-read",
            fallback_on_unowned: false,
            detail: "depends on an unresolved dynamic filesystem read while uncovered files changed; widened conservatively (enable --enforce-declared-reads to verify at runtime).",
        },
    );
}

/// When any changed path has been deleted from disk, its reverse edges vanish from the current
/// working-tree graph and every consumer that still imports it records an unresolved module
/// uncertainty. Widen those unresolved importers (and every module that imports them) so
/// cross-project deletes never silently skip broken tests or typechecks.
pub(super) fn widen_unresolved_module_importers_on_delete<'a>(
    manifest: &'a TestingManifest,
    workspace_root: &Path,
    changed_paths: &[String],
    graph: &DependencyGraph,
    evidence: &mut PlanEvidence<'a>,
    has_non_test_reachability: bool,
) {
    if !changed_paths
        .iter()
        .any(|path| !workspace_root.join(path).is_file())
    {
        return;
    }
    let seeds: Vec<String> = graph
        .uncertainties()
        .into_iter()
        .filter(|u| {
            matches!(
                u.code.as_str(),
                "unresolved-local-module" | "unresolved-bare-module" | "unresolved-module-scheme"
            )
        })
        .map(|u| u.path)
        .collect();
    if seeds.is_empty() {
        return;
    }
    widen_reached_unresolved_projects(
        manifest,
        graph,
        evidence,
        has_non_test_reachability,
        seeds,
        UnresolvedWidenSpec {
            code: "unresolved-import-after-delete",
            fallback_on_unowned: true,
            detail: "depends on an unresolved module import while changed workspace files were deleted; widened conservatively.",
        },
    );
}

struct UnresolvedWidenSpec<'a> {
    code: &'a str,
    fallback_on_unowned: bool,
    detail: &'a str,
}

fn widen_reached_unresolved_projects<'a>(
    manifest: &'a TestingManifest,
    graph: &DependencyGraph,
    evidence: &mut PlanEvidence<'a>,
    has_non_test_reachability: bool,
    seeds: Vec<String>,
    spec: UnresolvedWidenSpec<'_>,
) {
    let reached = graph.reachability_from(seeds);
    let mut recorded_projects: BTreeSet<&'a str> = BTreeSet::new();
    let mut recorded_unowned = false;
    for reached_path in &reached.paths {
        let Some(project) = deepest_project_for_path(&manifest.projects, reached_path) else {
            if spec.fallback_on_unowned && !recorded_unowned {
                recorded_unowned = true;
                evidence.full_fallback = true;
                evidence
                    .full_fallback_issue_indexes
                    .push(evidence.issues.len());
                evidence.issues.push(PlanIssue {
                    path: Some(reached_path.clone()),
                    ..PlanIssue::new(
                        spec.code,
                        format!(
                            "{reached_path} {} (no declared project owner; selected the complete fallback).",
                            spec.detail
                        ),
                        IssueSeverity::Uncertainty,
                        IssueScope::Workspace,
                    )
                });
            }
            continue;
        };
        let id = project.id.as_str();
        evidence.reached_paths.insert(reached_path.clone());
        evidence
            .reached_paths_by_project
            .entry(id)
            .or_default()
            .insert(reached_path.clone());
        evidence.reachability_impacted_projects.insert(id);
        let local_only = is_isolated_test_file(reached_path, manifest, graph);
        if local_only {
            evidence.local_uncertainty_impacted_projects.insert(id);
        } else {
            evidence.uncertainty_impacted_projects.insert(id);
        }
        if has_non_test_reachability {
            evidence.typecheck_reachability_impacted_projects.insert(id);
            if local_only {
                evidence
                    .typecheck_local_uncertainty_impacted_projects
                    .insert(id);
            } else {
                evidence.typecheck_uncertainty_impacted_projects.insert(id);
            }
        }
        if recorded_projects.insert(id) {
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
                    spec.code,
                    format!("{reached_path} {}", spec.detail),
                    IssueSeverity::Uncertainty,
                    IssueScope::Module,
                )
            });
        }
    }
}

pub(super) fn push_unique_project_issue<'a>(
    evidence: &mut PlanEvidence<'a>,
    project_id: &'a str,
    issue: PlanIssue,
) {
    let duplicate = evidence
        .issue_indexes_by_project
        .get(project_id)
        .is_some_and(|indexes| {
            indexes.iter().any(|&idx| {
                evidence.issues.get(idx).is_some_and(|existing| {
                    existing.code == issue.code
                        && existing.path == issue.path
                        && existing.line == issue.line
                        && existing.column == issue.column
                })
            })
        });
    if !duplicate {
        let index = evidence.issues.len();
        evidence
            .issue_indexes_by_project
            .entry(project_id)
            .or_default()
            .push(index);
        evidence.issues.push(issue);
    }
}

/// No frontend answered at all: in a multi-project workspace, project dependencies cannot be
/// proven without graph analysis, so fail closed to the complete fallback. In a single-project
/// workspace, widening the lone project already selects every task.
pub(super) fn record_missing_frontend<'a>(
    manifest: &'a TestingManifest,
    evidence: &mut PlanEvidence<'a>,
) {
    let issue_index = evidence.issues.len();
    if manifest.projects.len() > 1 {
        evidence.full_fallback = true;
        evidence.full_fallback_issue_indexes.push(issue_index);
        evidence.issues.push(PlanIssue::new(
            "reachability-frontend-unavailable",
            "No precision frontend was available for changed modules; selected the complete fallback because cross-project dependencies cannot be proven without graph analysis.",
            IssueSeverity::Uncertainty,
            IssueScope::Workspace,
        ));
        return;
    }
    let changed: Vec<&'a str> = evidence.changed_projects.iter().copied().collect();
    evidence.reachability_impacted_projects.extend(&changed);
    evidence
        .typecheck_reachability_impacted_projects
        .extend(&changed);
    evidence.uncertainty_impacted_projects.extend(&changed);
    evidence
        .typecheck_uncertainty_impacted_projects
        .extend(&changed);
    for project in changed {
        evidence
            .issue_indexes_by_project
            .entry(project)
            .or_default()
            .push(issue_index);
    }
    evidence.issues.push(PlanIssue::new(
        "reachability-frontend-unavailable",
        "No precision frontend was available for changed modules; widened through declared project dependencies.",
        IssueSeverity::Uncertainty,
        IssueScope::Workspace,
    ));
}
