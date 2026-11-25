//! Attaching specialized fail-closed narrowing reports (lockfile, tsconfig `paths`, SQL) to
//! `PlanEvidence` before general path ownership and graph widening run.

use super::PlanEvidence;
use crate::graph::DependencyGraph;
use crate::lockfile_impact::analyze_lockfile_impact;
use crate::manifest::TestingManifest;
use crate::protocol::ResolvedScope;
use crate::sql_impact::analyze_sql_impact;
use crate::tsconfig_impact::analyze_tsconfig_impact;
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

pub(super) fn attach_tsconfig_impact(
    workspace_root: &Path,
    scope: &ResolvedScope,
    graph: Option<&DependencyGraph>,
    evidence: &mut PlanEvidence<'_>,
) {
    if scope.full_fallback || evidence.full_fallback {
        return;
    }
    let report = analyze_tsconfig_impact(workspace_root, scope, graph);
    evidence.issues.extend(report.issues);
    evidence.tsconfig_handled_paths = report.handled_paths;
    evidence.tsconfig_impacted_aliases = report.impacted_aliases;
    evidence.tsconfig_seeded_modules = report.seeded_modules;
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
