//! Workspace test-file ownership and overlapping-narrowing checks for `dad-test doctor`.

use crate::discover_vitest::VitestDiscovery;
use crate::git::git_untracked_paths;
use crate::manifest::{DeclaredTask, FileNarrowing, TestingManifest};
use crate::protocol::{DoctorFinding, IssueSeverity};
use crate::scope::{deepest_project_for_path, is_standard_test_path, path_matches_impact};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::Command;

pub(crate) fn check_test_file_ownership(
    manifest: &TestingManifest,
    files: &BTreeSet<String>,
    tasks_by_project: &BTreeMap<&str, Vec<&DeclaredTask>>,
    vitest_by_root: &BTreeMap<String, VitestDiscovery>,
    findings: &mut Vec<DoctorFinding>,
) -> usize {
    let mut checked = 0usize;
    for rel in files {
        if !is_doctor_test_file(rel) {
            continue;
        }
        if manifest
            .workspace
            .ignore_paths
            .iter()
            .any(|pattern| path_matches_impact(rel, pattern))
        {
            continue;
        }
        let Some(project) = deepest_project_for_path(&manifest.projects, rel) else {
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
            if task_claims_test_file(task, rel, project_vitest) {
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
        return explicit_test_args
            .iter()
            .any(|arg| arg == rel || path_matches_impact(rel, arg));
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

pub(crate) fn suffixes_matching_narrowing<'a>(
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

pub(crate) fn is_vitest_task(task: &DeclaredTask) -> bool {
    task.execution.executable == "vitest"
        || task.execution.executable.ends_with("/vitest")
        || (task.execution.executable == "npx"
            && task.execution.args.first().map(String::as_str) == Some("vitest"))
}

pub(crate) fn is_integration_task(task: &DeclaredTask) -> bool {
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

pub(crate) fn workspace_candidate_files(workspace_root: &Path) -> BTreeSet<String> {
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
