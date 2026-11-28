//! Fast static setup and runner-parity verifier (`dad-test doctor`).
//!
//! Proves five invariants without running test suites:
//! 1. Every project whose `vitest.config.*` splits on `VITEST_TIER` / `dadsVitestTier()` has an
//!    integration/e2e test target.
//! 2. Every Vitest task's `fileNarrowing` agrees with its project `vitest.config.*` and (when
//!    batched via `vitest-files`) with its batch runner's `vitest.config.*`.
//! 3. Every test file inside a test-owning project is claimed by at least one test task.
//! 4. No two `fileNarrowing`-enabled test tasks in the same project ambiguously claim the same
//!    test file.
//! 5. Zero whole-workspace graph uncertainties exist (delegated to `build_diagnose`).

use crate::diagnose::build_diagnose;
use crate::discover_vitest::{VitestDiscovery, inspect_project_vitest_config};
use crate::doctor_ownership::{
    check_test_file_ownership, is_integration_task, is_vitest_task, suffixes_matching_narrowing,
    workspace_candidate_files,
};
use crate::graph::DependencyGraph;
use crate::manifest::{BatchMode, DeclaredTask, TaskKind, TestingManifest};
use crate::protocol::{
    DoctorCounts, DoctorFinding, DoctorResult, IssueSeverity, PROTOCOL_SCHEMA_VERSION,
};
use crate::scope::{deepest_project_for_path, path_matches_impact};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub(crate) fn build_doctor(
    manifest: &TestingManifest,
    workspace_root: &Path,
    graph: Option<&DependencyGraph>,
) -> DoctorResult {
    let mut findings = Vec::new();
    let workspace_files = workspace_candidate_files(workspace_root);
    let mut vitest_by_root: BTreeMap<String, VitestDiscovery> = BTreeMap::new();
    let mut tasks_by_project: BTreeMap<&str, Vec<&DeclaredTask>> = BTreeMap::new();
    let mut test_tasks_checked = 0usize;

    for task in &manifest.tasks {
        if task.kind == TaskKind::Test {
            test_tasks_checked += 1;
            tasks_by_project
                .entry(task.project.as_str())
                .or_default()
                .push(task);
        }
    }

    for project in &manifest.projects {
        let discovery = vitest_by_root
            .entry(project.root.clone())
            .or_insert_with(|| inspect_project_vitest_config(workspace_root, &project.root))
            .clone();
        let project_tasks = tasks_by_project
            .get(project.id.as_str())
            .map(Vec::as_slice)
            .unwrap_or(&[]);

        check_vitest_tier_target(
            manifest,
            project.id.as_str(),
            &project.root,
            &discovery,
            project_tasks,
            &workspace_files,
            &mut findings,
        );
        for task in project_tasks {
            check_vitest_narrowing_parity(
                task,
                &discovery,
                workspace_root,
                &mut vitest_by_root,
                &mut findings,
            );
        }
    }

    let test_files_checked = check_test_file_ownership(
        manifest,
        &workspace_files,
        &tasks_by_project,
        &vitest_by_root,
        &mut findings,
    );

    let diagnose = build_diagnose(manifest, workspace_root, graph);
    let workspace_uncertainties = diagnose.summary.whole_workspace_uncertainties;
    for issue in &diagnose.workspace_uncertainties {
        findings.push(DoctorFinding {
            code: "workspace-uncertainty".to_owned(),
            severity: IssueSeverity::Error,
            project: issue.project.clone(),
            task_id: None,
            path: if issue.path.is_empty() {
                None
            } else {
                Some(issue.path.clone())
            },
            message: issue.message.clone(),
            fix: "Run `dad-test diagnose` to inspect and scope this whole-workspace uncertainty."
                .to_owned(),
        });
    }

    let errors = findings
        .iter()
        .filter(|item| item.severity == IssueSeverity::Error)
        .count();
    let warnings = findings.len().saturating_sub(errors);

    DoctorResult {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        ok: errors == 0,
        counts: DoctorCounts {
            projects_checked: manifest.projects.len(),
            test_tasks_checked,
            test_files_checked,
            errors,
            warnings,
            workspace_uncertainties,
        },
        findings,
    }
}

fn check_vitest_tier_target(
    manifest: &TestingManifest,
    project_id: &str,
    project_root: &str,
    discovery: &VitestDiscovery,
    project_tasks: &[&DeclaredTask],
    workspace_files: &BTreeSet<String>,
    findings: &mut Vec<DoctorFinding>,
) {
    if !discovery.tiers.uses_vitest_tier {
        return;
    }
    if project_tasks.iter().any(|task| is_integration_task(task)) {
        return;
    }
    let excluded = &discovery.tiers.excluded_tier_suffixes;
    let first_tier_file = workspace_files.iter().find(|rel| {
        excluded.iter().any(|suffix| rel.ends_with(suffix))
            && !manifest
                .workspace
                .ignore_paths
                .iter()
                .any(|pattern| path_matches_impact(rel, pattern))
            && deepest_project_for_path(&manifest.projects, rel)
                .is_some_and(|owner| owner.id == project_id)
    });
    if let Some(sample_file) = first_tier_file {
        findings.push(DoctorFinding {
            code: "vitest-tier-missing-integration-target".to_owned(),
            severity: IssueSeverity::Error,
            project: Some(project_id.to_owned()),
            task_id: None,
            path: discovery.config_path.clone(),
            message: format!(
                "Project '{project_id}' splits unit/integration tiers in {} (VITEST_TIER / dadsVitestTier) and contains '{sample_file}' but has no test:integration or test:e2e target.",
                discovery.config_path.as_deref().unwrap_or("vitest.config")
            ),
            fix: format!(
                "Add a \"test:integration\" target to '{project_root}/project.json' (or configure a test:integration template in dads.testing.json)."
            ),
        });
    }
}

fn check_vitest_narrowing_parity(
    task: &DeclaredTask,
    project_vitest: &VitestDiscovery,
    workspace_root: &Path,
    vitest_by_root: &mut BTreeMap<String, VitestDiscovery>,
    findings: &mut Vec<DoctorFinding>,
) {
    let Some(narrowing) = task.execution.file_narrowing.as_ref() else {
        return;
    };
    if !is_vitest_task(task) || is_integration_task(task) {
        return;
    }

    // 1. Check project's own vitest.config.* exclusions against task fileNarrowing
    if project_vitest.tiers.excludes_integration_tiers
        && !project_vitest.tiers.uses_dads_vitest_tier
    {
        let leaked =
            suffixes_matching_narrowing(&project_vitest.tiers.excluded_tier_suffixes, narrowing);
        if !leaked.is_empty() {
            findings.push(DoctorFinding {
                code: "vitest-narrowing-mismatch".to_owned(),
                severity: IssueSeverity::Error,
                project: Some(task.project.clone()),
                task_id: Some(task.id.clone()),
                path: project_vitest.config_path.clone(),
                message: format!(
                    "Task '{}' fileNarrowing allows {} which {} excludes in default (unit) mode.",
                    task.id,
                    leaked.join(", "),
                    project_vitest.config_path.as_deref().unwrap_or("vitest.config")
                ),
                fix: format!(
                    "Add {} to {} fileNarrowing.excludeSuffixes or switch vitest.config to dadsVitestTier().",
                    leaked.join(", "),
                    task.id
                ),
            });
        }
    }

    // 2. Check vitest-files batch root vitest.config.* exclusions against task fileNarrowing
    if task
        .execution
        .batch
        .as_ref()
        .is_some_and(|b| b.mode == Some(BatchMode::VitestFiles))
    {
        let batch_root = ".".to_owned();
        let batch_vitest = vitest_by_root
            .entry(batch_root.clone())
            .or_insert_with(|| inspect_project_vitest_config(workspace_root, &batch_root));
        if batch_vitest.tiers.excludes_integration_tiers
            && !batch_vitest.tiers.uses_dads_vitest_tier
        {
            let leaked =
                suffixes_matching_narrowing(&batch_vitest.tiers.excluded_tier_suffixes, narrowing);
            if !leaked.is_empty() {
                findings.push(DoctorFinding {
                    code: "vitest-narrowing-mismatch".to_owned(),
                    severity: IssueSeverity::Error,
                    project: Some(task.project.clone()),
                    task_id: Some(task.id.clone()),
                    path: batch_vitest.config_path.clone(),
                    message: format!(
                        "Batched vitest-files task '{}' allows {} but batch runner config {} excludes them.",
                        task.id,
                        leaked.join(", "),
                        batch_vitest.config_path.as_deref().unwrap_or("vitest.config")
                    ),
                    fix: format!(
                        "Switch {} to dadsVitestTier(), exclude {} from {} fileNarrowing.excludeSuffixes, or exclude '{}' from vitest-files batching.",
                        batch_vitest.config_path.as_deref().unwrap_or("vitest.config"),
                        leaked.join(", "),
                        task.id,
                        task.project
                    ),
                });
            }
        }
    }
}
