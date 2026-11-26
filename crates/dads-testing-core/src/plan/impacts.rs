//! Attaching specialized fail-closed narrowing reports (lockfile, tsconfig `paths`, SQL) to
//! `PlanEvidence` before general path ownership and graph widening run.

use super::PlanEvidence;
use crate::graph::DependencyGraph;
use crate::lockfile_impact::analyze_lockfile_impact;
use crate::manifest::TestingManifest;
use crate::protocol::{IssueScope, IssueSeverity, PlanIssue, ResolvedScope};
use crate::scope::path_matches_impact;
use crate::sql_impact::analyze_sql_impact;
use crate::tsconfig_extends::{collect_tsconfig_extends_chain, list_tsconfig_files_in_dir};
use crate::tsconfig_impact::analyze_tsconfig_impact;
use std::collections::BTreeSet;
use std::path::Path;

pub(super) fn attach_lockfile_impact(
    workspace_root: &Path,
    scope: &ResolvedScope,
    graph: Option<&DependencyGraph>,
    evidence: &mut PlanEvidence<'_>,
) {
    if scope.full_fallback || evidence.full_fallback {
        return;
    }
    let report = analyze_lockfile_impact(workspace_root, scope, graph);
    evidence.issues.extend(report.issues);
    evidence.lockfile_handled_paths = report.handled_paths;
    evidence.lockfile_impacted_packages = report.impacted_packages;
    evidence.lockfile_seeded_modules = report.seeded_modules;
}

pub(super) fn attach_tsconfig_impact<'a>(
    manifest: &'a TestingManifest,
    workspace_root: &Path,
    scope: &ResolvedScope,
    graph: Option<&DependencyGraph>,
    evidence: &mut PlanEvidence<'a>,
) {
    if scope.full_fallback || evidence.full_fallback {
        return;
    }
    let report = analyze_tsconfig_impact(workspace_root, scope, graph);
    evidence.issues.extend(report.issues);
    evidence.tsconfig_handled_paths = report.handled_paths;
    evidence.tsconfig_impacted_aliases = report.impacted_aliases;
    evidence.tsconfig_seeded_modules = report.seeded_modules;
    attach_tsconfig_extends_impact(manifest, workspace_root, scope, evidence);
}

fn attach_tsconfig_extends_impact<'a>(
    manifest: &'a TestingManifest,
    workspace_root: &Path,
    scope: &ResolvedScope,
    evidence: &mut PlanEvidence<'a>,
) {
    let changed_json: BTreeSet<&str> = scope
        .changed_paths
        .iter()
        .map(String::as_str)
        .filter(|path| {
            path.ends_with(".json")
                && !evidence.tsconfig_handled_paths.contains(*path)
                && !evidence.lockfile_handled_paths.contains(*path)
                && !path.ends_with("/package-lock.json")
                && *path != "package-lock.json"
                && !manifest
                    .workspace
                    .ignore_paths
                    .iter()
                    .any(|pat| path_matches_impact(path, pat))
        })
        .collect();
    if changed_json.is_empty() {
        return;
    }
    for project in &manifest.projects {
        let project_id = project.id.as_str();
        let dirs = project_and_ancestor_dirs(&project.root);
        let mut widened_this_project = false;
        for dir_rel in dirs {
            let Some(tsconfigs) = list_tsconfig_files_in_dir(workspace_root, &dir_rel) else {
                mark_tsconfig_extends_project(
                    evidence,
                    project_id,
                    "tsconfig-extends-unresolved",
                    &dir_rel,
                    format!(
                        "Could not scan TypeScript configs in {dir_rel} while JSON configs changed; widened {project_id} conservatively."
                    ),
                );
                break;
            };
            for tsconfig_rel in tsconfigs {
                match collect_tsconfig_extends_chain(workspace_root, &tsconfig_rel) {
                    Some(chain) => {
                        if let Some(matched) =
                            chain.iter().find(|ext| changed_json.contains(ext.as_str()))
                        {
                            mark_tsconfig_extends_project(
                                evidence,
                                project_id,
                                "tsconfig-extends-changed",
                                matched,
                                format!(
                                    "{tsconfig_rel} extends changed TypeScript config {matched}; widened {project_id} conservatively."
                                ),
                            );
                            widened_this_project = true;
                            break;
                        }
                    }
                    None => {
                        mark_tsconfig_extends_project(
                            evidence,
                            project_id,
                            "tsconfig-extends-unresolved",
                            &tsconfig_rel,
                            format!(
                                "{tsconfig_rel} has an unreadable, malformed, or missing `extends` target while JSON configs changed; widened {project_id} conservatively."
                            ),
                        );
                        widened_this_project = true;
                        break;
                    }
                }
            }
            if widened_this_project {
                break;
            }
        }
    }
}

fn project_and_ancestor_dirs(root: &str) -> Vec<String> {
    let trimmed = root.trim().trim_matches('/');
    if trimmed.is_empty() || trimmed == "." {
        return Vec::new();
    }
    let mut dirs = Vec::new();
    let mut cursor = trimmed;
    loop {
        dirs.push(cursor.to_owned());
        let Some((parent, _)) = cursor.rsplit_once('/') else {
            break;
        };
        cursor = parent;
    }
    dirs
}

fn mark_tsconfig_extends_project<'a>(
    evidence: &mut PlanEvidence<'a>,
    project_id: &'a str,
    code: &str,
    path: &str,
    message: String,
) {
    evidence.reachability_impacted_projects.insert(project_id);
    evidence.uncertainty_impacted_projects.insert(project_id);
    evidence
        .typecheck_reachability_impacted_projects
        .insert(project_id);
    evidence
        .typecheck_uncertainty_impacted_projects
        .insert(project_id);
    let idx = evidence.issues.len();
    evidence
        .issue_indexes_by_project
        .entry(project_id)
        .or_default()
        .push(idx);
    evidence.issues.push(PlanIssue {
        path: Some(path.to_owned()),
        project: Some(project_id.to_owned()),
        ..PlanIssue::new(
            code,
            message,
            IssueSeverity::Uncertainty,
            IssueScope::Module,
        )
    });
}

pub(super) fn attach_sql_impact(
    manifest: &TestingManifest,
    workspace_root: &Path,
    scope: &ResolvedScope,
    evidence: &mut PlanEvidence<'_>,
) {
    if scope.full_fallback || evidence.full_fallback {
        return;
    }
    let report = analyze_sql_impact(manifest, scope, workspace_root);
    let offset = evidence.issues.len();
    evidence.issues.extend(report.issues);
    evidence.sql_handled_paths = report.handled_paths;
    for (task_id, mut selection) in report.selected_tasks {
        for idx in &mut selection.issue_indexes {
            *idx += offset;
        }
        evidence.sql_selected_tasks.insert(task_id, selection);
    }
}
