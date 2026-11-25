//! Fail-closed per-alias narrowing for TypeScript configuration files (`tsconfig.json`,
//! `tsconfig.base.json`, `tsconfig.paths.json`, etc.).
//!
//! When a changed tsconfig file modifies ONLY `compilerOptions.paths`, global widening is lifted
//! for that tsconfig and replaced by seeding only workspace modules whose imports match a changed
//! (added, modified, or removed) alias pattern — plus their reverse-reachable dependents.
//! Any parse error, missing base/head file, or change outside `compilerOptions.paths` stays
//! strictly fail-closed.

use crate::graph::DependencyGraph;
use crate::protocol::{IssueScope, IssueSeverity, PlanIssue, ResolvedScope};
use crate::tsconfig_parse::{TsconfigDiff, diff_tsconfig_paths};
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Default)]
pub(crate) struct TsconfigImpactReport {
    pub(crate) handled_paths: BTreeSet<String>,
    pub(crate) impacted_aliases: BTreeSet<String>,
    pub(crate) seeded_modules: Vec<String>,
    pub(crate) issues: Vec<PlanIssue>,
}

pub(crate) fn is_tsconfig_path(path: &str) -> bool {
    let file_name = path.rsplit('/').next().unwrap_or(path);
    file_name == "tsconfig.json"
        || (file_name.starts_with("tsconfig.") && file_name.ends_with(".json"))
}

pub(crate) fn analyze_tsconfig_impact(
    workspace_root: &Path,
    scope: &ResolvedScope,
    graph: Option<&DependencyGraph>,
) -> TsconfigImpactReport {
    let mut report = TsconfigImpactReport::default();
    let changed_tsconfigs: Vec<&str> = scope
        .changed_paths
        .iter()
        .map(String::as_str)
        .filter(|path| is_tsconfig_path(path))
        .collect();
    if changed_tsconfigs.is_empty() {
        return report;
    }
    let (Some(graph), Some(base_ref)) = (graph, scope.base.as_deref()) else {
        return report;
    };

    let mut seeded = BTreeSet::new();
    for tsconfig_path in changed_tsconfigs {
        analyze_one_tsconfig(
            workspace_root,
            base_ref,
            scope,
            graph,
            tsconfig_path,
            &mut seeded,
            &mut report,
        );
    }
    report.seeded_modules = seeded.into_iter().collect();
    report
}

fn analyze_one_tsconfig(
    workspace_root: &Path,
    base_ref: &str,
    scope: &ResolvedScope,
    graph: &DependencyGraph,
    tsconfig_path: &str,
    seeded: &mut BTreeSet<String>,
    report: &mut TsconfigImpactReport,
) {
    let Some(base_raw) = read_git_file(workspace_root, base_ref, tsconfig_path) else {
        report.issues.push(PlanIssue {
            path: Some(tsconfig_path.to_owned()),
            ..PlanIssue::new(
                "tsconfig-base-unavailable",
                format!(
                    "{tsconfig_path} could not be read from base {base_ref}; keeping conservative widening."
                ),
                IssueSeverity::Uncertainty,
                IssueScope::Workspace,
            )
        });
        return;
    };
    let Some(head_raw) = read_target_file(workspace_root, scope, tsconfig_path) else {
        report.issues.push(PlanIssue {
            path: Some(tsconfig_path.to_owned()),
            ..PlanIssue::new(
                "tsconfig-head-unavailable",
                format!(
                    "{tsconfig_path} could not be read from target; keeping conservative widening."
                ),
                IssueSeverity::Uncertainty,
                IssueScope::Workspace,
            )
        });
        return;
    };

    match diff_tsconfig_paths(&base_raw, &head_raw) {
        TsconfigDiff::ParseError => {
            report.issues.push(PlanIssue {
                path: Some(tsconfig_path.to_owned()),
                ..PlanIssue::new(
                    "tsconfig-parse-fallback",
                    format!(
                        "Could not parse {tsconfig_path} as JSONC; keeping conservative widening."
                    ),
                    IssueSeverity::Uncertainty,
                    IssueScope::Workspace,
                )
            });
        }
        TsconfigDiff::GlobalChange { reason } => {
            report.issues.push(PlanIssue {
                path: Some(tsconfig_path.to_owned()),
                ..PlanIssue::new(
                    "tsconfig-global-change",
                    format!(
                        "{tsconfig_path} changed outside compilerOptions.paths ({reason}); keeping conservative widening."
                    ),
                    IssueSeverity::Info,
                    IssueScope::Workspace,
                )
            });
        }
        TsconfigDiff::PathsOnly {
            changed_aliases,
            added_only,
        } => {
            let direct_matches = graph.modules_matching_path_aliases(&changed_aliases);
            let reached = graph.reachability_from(direct_matches.clone()).paths;
            let seeded_count = reached.len();
            seeded.extend(reached);
            report.handled_paths.insert(tsconfig_path.to_owned());
            let alias_count = changed_aliases.len();
            report.impacted_aliases.extend(changed_aliases);

            let detail = if alias_count == 0 {
                format!(
                    "{tsconfig_path} had no semantic compilerOptions changes; 0 workspace modules seeded."
                )
            } else if seeded_count == 0 && added_only {
                format!(
                    "{tsconfig_path} added {alias_count} unused path alias(es); 0 workspace modules import them."
                )
            } else {
                format!(
                    "{tsconfig_path} impacted {alias_count} path alias(es), seeding {seeded_count} workspace module(s)."
                )
            };
            report.issues.push(PlanIssue {
                path: Some(tsconfig_path.to_owned()),
                ..PlanIssue::new(
                    "tsconfig-paths-narrowed",
                    detail,
                    IssueSeverity::Info,
                    IssueScope::Workspace,
                )
            });
        }
    }
}

fn read_git_file(workspace_root: &Path, rev: &str, relative_path: &str) -> Option<String> {
    let spec = format!("{rev}:{relative_path}");
    let output = Command::new("git")
        .args(["show", &spec])
        .current_dir(workspace_root)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8(output.stdout).ok())
        .flatten()
}

fn read_target_file(
    workspace_root: &Path,
    scope: &ResolvedScope,
    relative_path: &str,
) -> Option<String> {
    if scope.kind == "commit-to-commit" {
        read_git_file(workspace_root, scope.head.as_deref()?, relative_path)
    } else {
        fs::read_to_string(workspace_root.join(relative_path)).ok()
    }
}
