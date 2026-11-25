//! Turning changed paths into impacted projects. Every step that cannot prove an answer records
//! a located issue and widens, so a plan is never quietly narrower than the evidence supports.
use super::PlanEvidence;
use super::widening_fs::{
    collect_graph_changed_paths, matching_fs_dir_nodes, record_fs_dir_reachable_path,
    record_missing_frontend, widen_ambient_dts_typechecks, widen_unresolved_fs_readers,
};
use crate::graph::{DependencyGraph, GraphUncertainty, GraphUncertaintyScope};
use crate::manifest::{ImpactMode, TaskKind, TestingManifest};
use crate::protocol::{IssueScope, IssueSeverity, PlanIssue, ResolvedScope};
use crate::scope::{
    deepest_project_for_path, dynamic_import_scope_triggered, is_isolated_test_file,
    path_matches_impact,
};
use std::collections::BTreeSet;

/// Attributes each changed path to its owning project. A path no declared project owns cannot be
/// reasoned about at all, so it selects the complete fallback.
pub(super) fn own_changed_paths<'a>(
    manifest: &'a TestingManifest,
    scope: &ResolvedScope,
    evidence: &mut PlanEvidence<'a>,
) {
    if scope.full_fallback {
        return;
    }
    for changed_path in &scope.changed_paths {
        if evidence.lockfile_handled_paths.contains(changed_path)
            || evidence.tsconfig_handled_paths.contains(changed_path)
        {
            continue;
        }
        if manifest
            .workspace
            .ignore_paths
            .iter()
            .any(|pattern| path_matches_impact(changed_path, pattern))
        {
            continue;
        }
        match deepest_project_for_path(&manifest.projects, changed_path) {
            Some(project) => {
                evidence.changed_projects.insert(project.id.as_str());
                evidence
                    .fallback_impacted_projects
                    .insert(project.id.as_str());
                evidence
                    .changed_paths_by_project
                    .entry(project.id.as_str())
                    .or_default()
                    .push(changed_path.clone());
            }
            None => {
                evidence.full_fallback = true;
                evidence
                    .full_fallback_issue_indexes
                    .push(evidence.issues.len());
                evidence.issues.push(PlanIssue {
                    path: Some(changed_path.clone()),
                    ..PlanIssue::new(
                        "unknown-changed-path",
                        format!(
                            "{changed_path} is not owned by a declared project; selected the complete fallback."
                        ),
                        IssueSeverity::Uncertainty,
                        IssueScope::Workspace,
                    )
                });
            }
        }
    }
    for seeded in evidence
        .lockfile_seeded_modules
        .iter()
        .chain(&evidence.tsconfig_seeded_modules)
    {
        if let Some(project) = deepest_project_for_path(&manifest.projects, seeded) {
            evidence.changed_projects.insert(project.id.as_str());
            evidence
                .fallback_impacted_projects
                .insert(project.id.as_str());
            evidence
                .changed_paths_by_project
                .entry(project.id.as_str())
                .or_default()
                .push(seeded.clone());
        }
    }
}

/// Follows the precision frontend's evidence where there is any, and records the widening where
/// there is not. Only a manifest that declares reachability impact can use a graph at all.
pub(super) fn widen_through_graph<'a>(
    manifest: &'a TestingManifest,
    scope: &ResolvedScope,
    graph: Option<&DependencyGraph>,
    enforce_declared_reads: bool,
    evidence: &mut PlanEvidence<'a>,
) {
    if evidence.full_fallback || scope.changed_paths.is_empty() || !manifest.declares_graph_reader()
    {
        return;
    }
    let changed_paths = collect_graph_changed_paths(manifest, scope, graph, evidence);
    if changed_paths.is_empty() {
        return;
    }
    let Some(graph) = graph else {
        record_missing_frontend(manifest, evidence);
        return;
    };
    let (mut covered_paths, uncovered_paths): (Vec<String>, Vec<String>) = changed_paths
        .iter()
        .cloned()
        .partition(|path| graph.contains_path(path));
    for dir_node in matching_fs_dir_nodes(graph, &changed_paths) {
        if !covered_paths.contains(&dir_node) {
            covered_paths.push(dir_node);
        }
    }
    let has_non_test_reachability = manifest
        .tasks
        .iter()
        .any(|t| t.impact.mode == ImpactMode::Reachability && !matches!(t.kind, TaskKind::Test));
    if !covered_paths.is_empty() {
        let runtime_reachable = graph.symbol_reachability_runtime(covered_paths.clone());
        record_reachable_paths(manifest, &runtime_reachable.paths, evidence, true);
        record_reachable_uncertainties(
            manifest,
            &changed_paths,
            graph,
            runtime_reachable.uncertainties,
            evidence,
            true,
            enforce_declared_reads,
        );
        evidence.reached_edges = runtime_reachable.edges;
        if has_non_test_reachability {
            let full_reachable = graph.symbol_reachability_from(covered_paths);
            widen_ambient_dts_typechecks(
                manifest,
                &changed_paths,
                Some(&full_reachable.paths),
                evidence,
            );
            record_reachable_paths(manifest, &full_reachable.paths, evidence, false);
            record_reachable_uncertainties(
                manifest,
                &changed_paths,
                graph,
                full_reachable.uncertainties,
                evidence,
                false,
                enforce_declared_reads,
            );
        }
    }
    if !uncovered_paths.is_empty() {
        record_uncovered_paths(manifest, &uncovered_paths, evidence);
        if has_non_test_reachability {
            widen_ambient_dts_typechecks(manifest, &uncovered_paths, None, evidence);
        }
        if !enforce_declared_reads {
            widen_unresolved_fs_readers(manifest, graph, evidence, has_non_test_reachability);
        }
        let workspace_uncertainties = graph.whole_workspace_uncertainties();
        record_reachable_uncertainties(
            manifest,
            &changed_paths,
            graph,
            workspace_uncertainties.clone(),
            evidence,
            true,
            enforce_declared_reads,
        );
        if has_non_test_reachability {
            record_reachable_uncertainties(
                manifest,
                &changed_paths,
                graph,
                workspace_uncertainties,
                evidence,
                false,
                enforce_declared_reads,
            );
        }
    }
}

/// The frontend answered, but not about these paths: ONLY their owning projects widen through
/// declared fallback dependents; covered JS/TS paths in other projects keep exact symbol narrowing.
fn record_uncovered_paths<'a>(
    manifest: &'a TestingManifest,
    uncovered_paths: &[String],
    evidence: &mut PlanEvidence<'a>,
) {
    for uncovered_path in uncovered_paths {
        let owning_project = deepest_project_for_path(&manifest.projects, uncovered_path);
        if let Some(project) = owning_project {
            let id = project.id.as_str();
            evidence.reachability_impacted_projects.insert(id);
            evidence.typecheck_reachability_impacted_projects.insert(id);
            evidence.uncertainty_impacted_projects.insert(id);
            evidence.typecheck_uncertainty_impacted_projects.insert(id);
            let index = evidence.issues.len();
            evidence
                .issue_indexes_by_project
                .entry(id)
                .or_default()
                .push(index);
        }
        evidence.issues.push(PlanIssue {
            path: Some(uncovered_path.clone()),
            project: owning_project.map(|project| project.id.clone()),
            ..PlanIssue::new(
                "changed-module-unavailable",
                format!(
                    "{uncovered_path} is not covered by the precision frontend; widened through declared project dependencies."
                ),
                IssueSeverity::Uncertainty,
                IssueScope::Module,
            )
        });
    }
}

/// Proven reachability: every reached module puts its owner in scope, and a reached module with
/// no owner means the graph reaches outside the manifest, which forces the complete fallback.
fn record_reachable_paths<'a>(
    manifest: &'a TestingManifest,
    paths: &BTreeSet<String>,
    evidence: &mut PlanEvidence<'a>,
    for_runtime_tests: bool,
) {
    for path in paths {
        if record_fs_dir_reachable_path(manifest, path, evidence, for_runtime_tests) {
            continue;
        }
        if for_runtime_tests {
            evidence.reached_paths.insert(path.clone());
        }
        if let Some(project) = deepest_project_for_path(&manifest.projects, path) {
            if for_runtime_tests {
                evidence
                    .reachability_impacted_projects
                    .insert(project.id.as_str());
                evidence
                    .reached_paths_by_project
                    .entry(project.id.as_str())
                    .or_default()
                    .insert(path.clone());
            } else {
                evidence
                    .typecheck_reachability_impacted_projects
                    .insert(project.id.as_str());
            }
        } else {
            evidence.full_fallback = true;
            evidence
                .full_fallback_issue_indexes
                .push(evidence.issues.len());
            evidence.issues.push(PlanIssue {
                path: Some(path.clone()),
                ..PlanIssue::new(
                    "reachable-module-unowned",
                    format!(
                        "{path} is reachable but has no declared project owner; selected the complete fallback."
                    ),
                    IssueSeverity::Uncertainty,
                    IssueScope::Workspace,
                )
            });
        }
    }
}

/// Where the traversal stopped being provable. An owned uncertainty widens its project (confined
/// to its own project when it lives in an unimported test file); an unowned one has nothing to
/// widen, so it selects the complete fallback.
fn record_reachable_uncertainties<'a>(
    manifest: &'a TestingManifest,
    changed_paths: &[String],
    graph: &DependencyGraph,
    uncertainties: Vec<GraphUncertainty>,
    evidence: &mut PlanEvidence<'a>,
    for_runtime_tests: bool,
    enforce_declared_reads: bool,
) {
    for uncertainty in uncertainties {
        if uncertainty.code == "unresolved-fs-read" && enforce_declared_reads {
            continue;
        }
        if uncertainty.scope == GraphUncertaintyScope::WholeWorkspace
            && let Some(prefixes) = manifest
                .workspace
                .dynamic_import_scopes
                .get(&uncertainty.path)
            && !dynamic_import_scope_triggered(&uncertainty.path, prefixes, changed_paths)
        {
            continue;
        }
        let owning_project = deepest_project_for_path(&manifest.projects, &uncertainty.path);
        let position = uncertainty
            .location
            .as_ref()
            .map(|location| location.position);
        let uncertainty_scope = match uncertainty.scope {
            GraphUncertaintyScope::WholeWorkspace => IssueScope::Workspace,
            GraphUncertaintyScope::ReachedModule => IssueScope::Module,
        };
        match owning_project {
            Some(project) => {
                let local_only = is_isolated_test_file(&uncertainty.path, manifest, graph);
                match (for_runtime_tests, local_only) {
                    (true, true) => {
                        evidence
                            .local_uncertainty_impacted_projects
                            .insert(project.id.as_str());
                    }
                    (true, false) => {
                        evidence
                            .uncertainty_impacted_projects
                            .insert(project.id.as_str());
                    }
                    (false, true) => {
                        evidence
                            .typecheck_local_uncertainty_impacted_projects
                            .insert(project.id.as_str());
                    }
                    (false, false) => {
                        evidence
                            .typecheck_uncertainty_impacted_projects
                            .insert(project.id.as_str());
                    }
                }
                let index = evidence.issues.len();
                evidence
                    .issue_indexes_by_project
                    .entry(project.id.as_str())
                    .or_default()
                    .push(index);
                evidence.issues.push(PlanIssue {
                    path: Some(uncertainty.path.clone()),
                    project: Some(project.id.clone()),
                    line: position.map(|position| position.line),
                    column: position.map(|position| position.column),
                    ..PlanIssue::new(
                        uncertainty.code,
                        format!(
                            "{}: {}; widened through declared project dependencies.",
                            uncertainty.path, uncertainty.message
                        ),
                        IssueSeverity::Uncertainty,
                        uncertainty_scope,
                    )
                });
            }
            None => {
                evidence.full_fallback = true;
                evidence
                    .full_fallback_issue_indexes
                    .push(evidence.issues.len());
                evidence.issues.push(PlanIssue {
                    path: Some(uncertainty.path.clone()),
                    line: position.map(|position| position.line),
                    column: position.map(|position| position.column),
                    ..PlanIssue::new(
                        uncertainty.code,
                        format!(
                            "{}: {}; no project owns the uncertainty, so the complete fallback was selected.",
                            uncertainty.path, uncertainty.message
                        ),
                        IssueSeverity::Uncertainty,
                        uncertainty_scope,
                    )
                });
            }
        }
    }
}
