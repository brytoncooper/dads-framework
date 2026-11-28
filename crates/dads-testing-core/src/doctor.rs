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
use crate::git::git_untracked_paths;
use crate::graph::DependencyGraph;
use crate::manifest::{BatchMode, DeclaredTask, FileNarrowing, TaskKind, TestingManifest};
use crate::protocol::{
    DoctorCounts, DoctorFinding, DoctorResult, IssueSeverity, PROTOCOL_SCHEMA_VERSION,
};
use crate::scope::{deepest_project_for_path, is_standard_test_path, path_matches_impact};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::Command;

pub(crate) fn build_doctor(
    manifest: &TestingManifest,
    workspace_root: &Path,
    graph: Option<&DependencyGraph>,
) -> DoctorResult {
    let mut findings = Vec::new();
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

        check_vitest_tier_target(project.id.as_str(), &project.root, &discovery, project_tasks, &mut findings);
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
        workspace_root,
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
            path: if issue.path.is_empty() { None } else { Some(issue.path.clone()) },
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
    project_id: &str,
    project_root: &str,
    discovery: &VitestDiscovery,
    project_tasks: &[&DeclaredTask],
    findings: &mut Vec<DoctorFinding>,
) {
    if !discovery.tiers.uses_vitest_tier {
        return;
    }
    let has_integration = project_tasks.iter().any(|task| is_integration_task(task));
    if !has_integration {
        findings.push(DoctorFinding {
            code: "vitest-tier-missing-integration-target".to_owned(),
            severity: IssueSeverity::Error,
            project: Some(project_id.to_owned()),
            task_id: None,
            path: discovery.config_path.clone(),
            message: format!(
                "Project '{project_id}' splits unit/integration tiers in {} (VITEST_TIER / dadsVitestTier) but has no test:integration or test:e2e target.",
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
    if project_vitest.tiers.excludes_integration_tiers && !project_vitest.tiers.uses_dads_vitest_tier {
        let leaked = suffixes_matching_narrowing(&project_vitest.tiers.excluded_tier_suffixes, narrowing);
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
        let batch_root = task.execution.cwd.as_deref().unwrap_or(".").to_owned();
        let batch_vitest = vitest_by_root
            .entry(batch_root.clone())
            .or_insert_with(|| inspect_project_vitest_config(workspace_root, &batch_root));
        if batch_vitest.tiers.excludes_integration_tiers && !batch_vitest.tiers.uses_dads_vitest_tier {
            let leaked = suffixes_matching_narrowing(&batch_vitest.tiers.excluded_tier_suffixes, narrowing);
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

fn check_test_file_ownership(
    manifest: &TestingManifest,
    workspace_root: &Path,
    tasks_by_project: &BTreeMap<&str, Vec<&DeclaredTask>>,
    vitest_by_root: &BTreeMap<String, VitestDiscovery>,
    findings: &mut Vec<DoctorFinding>,
) -> usize {
    let mut checked = 0usize;
    let files = workspace_candidate_files(workspace_root);
    for rel in files {
        if !is_doctor_test_file(&rel) {
            continue;
        }
        if manifest
            .workspace
            .ignore_paths
            .iter()
            .any(|pattern| path_matches_impact(&rel, pattern))
        {
            continue;
        }
        let Some(project) = deepest_project_for_path(&manifest.projects, &rel) else {
            continue;
        };
        let project_tasks = tasks_by_project
            .get(project.id.as_str())
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let has_vitest = vitest_by_root
            .get(&project.root)
            .is_some_and(|v| v.config_path.is_some());
        let is_workspace_root = project.root == "." || project.root.is_empty();
        if project_tasks.is_empty() && (is_workspace_root || !has_vitest) {
            continue;
        }
        checked += 1;

        let project_vitest = vitest_by_root.get(&project.root);
        let mut claiming_all = Vec::new();
        let mut claiming_narrowed = Vec::new();
        for task in project_tasks {
            if task_claims_test_file(task, &rel, project_vitest) {
                claiming_all.push(task.id.as_str());
                if task.execution.file_narrowing.is_some() {
                    claiming_narrowed.push(task.id.as_str());
                }
            }
        }

        if claiming_all.is_empty() {
            findings.push(DoctorFinding {
                code: "unowned-test-file".to_owned(),
                severity: IssueSeverity::Error,
                project: Some(project.id.clone()),
                task_id: None,
                path: Some(rel.clone()),
                message: format!(
                    "Test file '{rel}' in project '{}' is not matched by any test task.",
                    project.id
                ),
                fix: format!(
                    "Wire a matching test task (e.g., \"test:integration\" for *.integration.test.*) in '{}/project.json' or adjust fileNarrowing in dads.testing.json.",
                    project.root
                ),
            });
        } else if claiming_narrowed.len() > 1 {
            findings.push(DoctorFinding {
                code: "overlapping-narrowing-targets".to_owned(),
                severity: IssueSeverity::Error,
                project: Some(project.id.clone()),
                task_id: Some(claiming_narrowed.join(", ")),
                path: Some(rel.clone()),
                message: format!(
                    "Test file '{rel}' in project '{}' is matched by multiple narrowed test tasks: {}.",
                    project.id,
                    claiming_narrowed.join(", ")
                ),
                fix: "Partition fileNarrowing suffixes/excludeSuffixes (or --exclude args) so each test file is owned by a single narrowed task."
                    .to_owned(),
            });
        }
    }
    checked
}

fn task_claims_test_file(
    task: &DeclaredTask,
    rel: &str,
    project_vitest: Option<&VitestDiscovery>,
) -> bool {
    if is_excluded_by_args(&task.execution.args, rel) {
        return false;
    }
    if let Some(narrowing) = task.execution.file_narrowing.as_ref() {
        return matches_narrowing(rel, narrowing);
    }
    let explicit_test_args = explicit_test_file_args(&task.execution.args);
    if !explicit_test_args.is_empty() {
        return explicit_test_args.iter().any(|arg| arg == rel || path_matches_impact(rel, arg));
    }
    if is_vitest_task(task)
        && !is_integration_task(task)
        && let Some(vitest) = project_vitest
        && vitest.tiers.excludes_integration_tiers
        && vitest
            .tiers
            .excluded_tier_suffixes
            .iter()
            .any(|suffix| rel.ends_with(suffix))
    {
        return false;
    }
    true
}

fn matches_narrowing(path: &str, narrowing: &FileNarrowing) -> bool {
    narrowing.suffixes.iter().any(|s| path.ends_with(s))
        && !narrowing.exclude_suffixes.iter().any(|e| path.ends_with(e))
}

fn suffixes_matching_narrowing<'a>(
    tier_suffixes: &'a [String],
    narrowing: &FileNarrowing,
) -> Vec<&'a str> {
    tier_suffixes
        .iter()
        .filter(|suffix| {
            let synthetic = format!("probe{suffix}");
            matches_narrowing(&synthetic, narrowing)
        })
        .map(String::as_str)
        .collect()
}

fn is_excluded_by_args(args: &[String], rel: &str) -> bool {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--exclude" {
            if let Some(next) = iter.next()
                && next.trim_start_matches("./") == rel
            {
                return true;
            }
        } else if let Some(val) = arg.strip_prefix("--exclude=")
            && val.trim_start_matches("./") == rel
        {
            return true;
        }
    }
    false
}

fn explicit_test_file_args(args: &[String]) -> Vec<String> {
    let mut files = Vec::new();
    let mut skip_next = false;
    for arg in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg == "--exclude" {
            skip_next = true;
            continue;
        }
        if arg.starts_with('-') {
            continue;
        }
        let normalized = arg.trim_start_matches("./");
        if is_standard_test_path(normalized) {
            files.push(normalized.to_owned());
        }
    }
    files
}

fn is_vitest_task(task: &DeclaredTask) -> bool {
    task.execution.executable == "vitest"
        || task.execution.executable.ends_with("/vitest")
        || (task.execution.executable == "npx"
            && task.execution.args.first().map(String::as_str) == Some("vitest"))
}

fn is_integration_task(task: &DeclaredTask) -> bool {
    task.id.ends_with(":test:integration")
        || task.id.ends_with(":test:e2e")
        || task
            .execution
            .env
            .get("VITEST_TIER")
            .is_some_and(|v| v == "integration" || v == "e2e")
}

fn is_doctor_test_file(rel: &str) -> bool {
    if !is_standard_test_path(rel) {
        return false;
    }
    // Skip fixture directories and build artifacts.
    for segment in rel.split('/') {
        if matches!(
            segment,
            "node_modules" | "dist" | ".git" | "target" | "fixtures" | "__fixtures__" | "__mocks__"
        ) {
            return false;
        }
    }
    true
}

fn workspace_candidate_files(workspace_root: &Path) -> BTreeSet<String> {
    let mut files = BTreeSet::new();
    if let Ok(output) = Command::new("git")
        .args(["ls-files", "-z"])
        .current_dir(workspace_root)
        .output()
        && output.status.success()
    {
        for raw in output.stdout.split(|&b| b == 0) {
            if raw.is_empty() {
                continue;
            }
            if let Ok(s) = std::str::from_utf8(raw) {
                files.insert(s.replace('\\', "/"));
            }
        }
    }
    if let Ok(untracked) = git_untracked_paths(workspace_root) {
        files.extend(untracked);
    }
    files
}
