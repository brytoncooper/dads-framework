//! Sound, fast per-file narrowed read-guard auditing (`dad-test audit`).
//!
//! Whole-task `audit` unions static imports across every sibling file in a project, which can mask
//! an undeclared dynamic read that fails once a real PR narrows the task to one test file.
//!
//! Three-step exact algorithm:
//! 1. Pass 1 runs each `fileNarrowing` task once against `A_common = intersect(A(F_1), ..., A(F_n))`.
//!    Because `A_common` is a subset of every `A(F_i)`, a task with 0 violations in Pass 1 is
//!    mathematically guaranteed to have 0 undeclared reads under every single-file narrowing.
//! 2. Pass 2 runs ONLY tasks that flagged in Pass 1, partitioning their test files into
//!    equivalence classes with identical narrowed allowlists `A(G)` (zero sibling masking!).
//! 3. Pass 3 runs ONLY failing groups of size > 1 one file at a time so every reported
//!    `UndeclaredRead` carries its exact `selected_file`.

use super::read_guard::should_guard_task;
use super::read_guard_allowlist::AllowlistBuilder;
use super::{RunOptions, run_plan_once};
use crate::execute::TestingError;
use crate::git::git_untracked_paths;
use crate::manifest::{DeclaredTask, FileNarrowing, TestingManifest};
use crate::protocol::{
    PlanCounts, PlanResult, ReadGuardMode, ResolvedScope, RunResult, TaskDecision,
    PROTOCOL_SCHEMA_VERSION, TaskReadGuardAllowlist, UndeclaredRead,
};
use crate::scope::{deepest_project_for_path, path_matches_impact};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::Command;

struct NarrowedTaskSpec {
    task_index: usize,
    task_id: String,
    matching_files: Vec<String>,
    per_file_allowlists: BTreeMap<String, TaskReadGuardAllowlist>,
}

pub(super) fn run_plan_audit_per_file(
    manifest: &TestingManifest,
    workspace_root: &Path,
    manifest_file: &Path,
    plan: &PlanResult,
    options: RunOptions<'_>,
) -> Result<RunResult, TestingError> {
    let declared: BTreeMap<&str, &DeclaredTask> = manifest
        .tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect();
    let allowlist_builder = AllowlistBuilder::new(manifest, options.graph);
    let candidate_files = workspace_candidate_files(workspace_root);

    let mut pass1_plan = clone_plan(plan);
    let mut narrowed_specs: BTreeMap<String, NarrowedTaskSpec> = BTreeMap::new();

    for (task_index, decision) in pass1_plan.tasks.iter_mut().enumerate() {
        if decision.decision != "run" || !decision.selected_files.is_empty() {
            continue;
        }
        let Some(&task) = declared.get(decision.id.as_str()) else {
            continue;
        };
        if !should_guard_task(&task.kind, &task.execution) {
            continue;
        }
        let Some(narrowing) = task.execution.file_narrowing.as_ref() else {
            continue;
        };
        let matching = matching_files_for_task(manifest, task, narrowing, &candidate_files);
        if matching.is_empty() {
            continue;
        }
        if matching.len() == 1 {
            let only_file = matching[0].clone();
            decision.selected_files = vec![only_file.clone()];
            decision.read_guard_allowlist = Some(allowlist_builder.for_task_parts(
                task,
                &decision.selected_files,
                None,
            ));
            narrowed_specs.insert(
                task.id.clone(),
                NarrowedTaskSpec {
                    task_index,
                    task_id: task.id.clone(),
                    matching_files: vec![only_file],
                    per_file_allowlists: BTreeMap::new(),
                },
            );
            continue;
        }
        let mut per_file = BTreeMap::new();
        for file in &matching {
            let allow = allowlist_builder.for_task_parts(task, std::slice::from_ref(file), None);
            per_file.insert(file.clone(), allow);
        }
        let common = TaskReadGuardAllowlist::intersect_many(per_file.values());
        decision.read_guard_allowlist = Some(common);
        narrowed_specs.insert(
            task.id.clone(),
            NarrowedTaskSpec {
                task_index,
                task_id: task.id.clone(),
                matching_files: matching,
                per_file_allowlists: per_file,
            },
        );
    }

    // Pass 1: run every task at full speed with A_common allowlists for narrowed tasks.
    let mut pass1_run = run_plan_once(
        manifest,
        workspace_root,
        manifest_file,
        &pass1_plan,
        RunOptions {
            audit_per_file: false,
            ..options
        },
    )?;

    // Tag single-file tasks directly with their selected_file.
    for spec in narrowed_specs.values() {
        if spec.matching_files.len() == 1 {
            let only_file = &spec.matching_files[0];
            if let Some(result) = pass1_run.tasks.get_mut(spec.task_index) {
                for read in &mut result.undeclared_reads {
                    if read.selected_file.is_none() {
                        read.selected_file = Some(only_file.clone());
                    }
                }
            }
        }
    }

    // Collect multi-file tasks that flagged reads outside A_common in Pass 1.
    let flagged_specs: Vec<&NarrowedTaskSpec> = narrowed_specs
        .values()
        .filter(|spec| {
            spec.matching_files.len() > 1
                && pass1_run
                    .tasks
                    .get(spec.task_index)
                    .is_some_and(|res| !res.undeclared_reads.is_empty())
        })
        .collect();

    if flagged_specs.is_empty() {
        return Ok(pass1_run);
    }

    // Pass 2: group each flagged task's files into exact allowlist equivalence classes.
    let mut pass2_manifest = manifest.clone();
    pass2_manifest.tasks.clear();
    let mut pass2_decisions = Vec::new();
    let mut pass2_meta: Vec<(usize, String, Vec<String>, TaskReadGuardAllowlist)> = Vec::new();

    for spec in &flagged_specs {
        let Some(&base_task) = declared.get(spec.task_id.as_str()) else {
            continue;
        };
        let mut by_allowlist: BTreeMap<TaskReadGuardAllowlist, Vec<String>> = BTreeMap::new();
        for file in &spec.matching_files {
            if let Some(allow) = spec.per_file_allowlists.get(file) {
                by_allowlist
                    .entry(allow.clone())
                    .or_default()
                    .push(file.clone());
            }
        }
        for (group_idx, (allowlist, files)) in by_allowlist.into_iter().enumerate() {
            let synth_id = format!("{}#audit-group-{group_idx}", spec.task_id);
            let mut synth_task = base_task.clone();
            synth_task.id = synth_id.clone();
            synth_task.depends_on.clear();
            synth_task.cache = false;
            synth_task.execution.batch = None;
            pass2_manifest.tasks.push(synth_task);
            pass2_decisions.push(synthetic_run_decision(
                synth_id,
                base_task.project.clone(),
                files.clone(),
                allowlist.clone(),
            ));
            pass2_meta.push((spec.task_index, spec.task_id.clone(), files, allowlist));
        }
    }

    let pass2_plan = synthetic_plan(pass2_decisions);
    let pass2_run = run_plan_once(
        &pass2_manifest,
        workspace_root,
        manifest_file,
        &pass2_plan,
        RunOptions {
            receipts: None,
            stream_enabled: false,
            read_guard_mode: Some(ReadGuardMode::Audit),
            audit_per_file: false,
            ..options
        },
    )?;

    // Collect confirmed violations per original task, and queue Pass 3 for multi-file failing groups.
    let mut confirmed_by_task: BTreeMap<usize, BTreeSet<UndeclaredRead>> = BTreeMap::new();
    for spec in &flagged_specs {
        confirmed_by_task.insert(spec.task_index, BTreeSet::new());
    }

    let mut pass3_manifest = manifest.clone();
    pass3_manifest.tasks.clear();
    let mut pass3_decisions = Vec::new();
    let mut pass3_meta: Vec<(usize, String)> = Vec::new();

    for (idx, group_result) in pass2_run.tasks.iter().enumerate() {
        if group_result.undeclared_reads.is_empty() {
            continue;
        }
        let (orig_idx, orig_id, files, allowlist) = &pass2_meta[idx];
        if files.len() == 1 {
            let file = &files[0];
            let entry = confirmed_by_task.entry(*orig_idx).or_default();
            for read in &group_result.undeclared_reads {
                entry.insert(UndeclaredRead {
                    path: read.path.clone(),
                    location: read.location.clone(),
                    api: read.api.clone(),
                    selected_file: Some(file.clone()),
                });
            }
            continue;
        }
        let Some(&base_task) = declared.get(orig_id.as_str()) else {
            continue;
        };
        for (file_idx, file) in files.iter().enumerate() {
            let synth_id = format!("{orig_id}#audit-file-{idx}-{file_idx}");
            let mut synth_task = base_task.clone();
            synth_task.id = synth_id.clone();
            synth_task.depends_on.clear();
            synth_task.cache = false;
            synth_task.execution.batch = None;
            pass3_manifest.tasks.push(synth_task);
            pass3_decisions.push(synthetic_run_decision(
                synth_id,
                base_task.project.clone(),
                vec![file.clone()],
                allowlist.clone(),
            ));
            pass3_meta.push((*orig_idx, file.clone()));
        }
    }

    // Pass 3: exact single-file attribution ONLY for failing groups with > 1 file.
    if !pass3_decisions.is_empty() {
        let pass3_plan = synthetic_plan(pass3_decisions);
        let pass3_run = run_plan_once(
            &pass3_manifest,
            workspace_root,
            manifest_file,
            &pass3_plan,
            RunOptions {
                receipts: None,
                stream_enabled: false,
                read_guard_mode: Some(ReadGuardMode::Audit),
                audit_per_file: false,
                ..options
            },
        )?;
        for (idx, file_result) in pass3_run.tasks.iter().enumerate() {
            if file_result.undeclared_reads.is_empty() {
                continue;
            }
            let (orig_idx, file) = &pass3_meta[idx];
            let entry = confirmed_by_task.entry(*orig_idx).or_default();
            for read in &file_result.undeclared_reads {
                entry.insert(UndeclaredRead {
                    path: read.path.clone(),
                    location: read.location.clone(),
                    api: read.api.clone(),
                    selected_file: Some(file.clone()),
                });
            }
        }
    }

    // Replace Pass-1 over-approximated reads on flagged tasks with exact per-file confirmed reads.
    for (orig_idx, reads) in confirmed_by_task {
        if let Some(task_result) = pass1_run.tasks.get_mut(orig_idx) {
            task_result.undeclared_reads = reads.into_iter().collect();
        }
    }

    Ok(pass1_run)
}

fn clone_plan(plan: &PlanResult) -> PlanResult {
    PlanResult {
        schema_version: plan.schema_version,
        scope: ResolvedScope {
            kind: plan.scope.kind.clone(),
            base: plan.scope.base.clone(),
            head: plan.scope.head.clone(),
            changed_paths: plan.scope.changed_paths.clone(),
            full_fallback: plan.scope.full_fallback,
        },
        tasks: plan.tasks.clone(),
        issues: plan.issues.clone(),
        complete: plan.complete,
        counts: PlanCounts {
            run: plan.counts.run,
            skip_proven_unaffected: plan.counts.skip_proven_unaffected,
        },
        shard: plan.shard.clone(),
        workspace_fingerprint: plan.workspace_fingerprint.clone(),
    }
}

fn synthetic_run_decision(
    id: String,
    project: String,
    selected_files: Vec<String>,
    allowlist: TaskReadGuardAllowlist,
) -> TaskDecision {
    TaskDecision {
        id,
        decision: "run".to_owned(),
        reason: "audit-per-file".to_owned(),
        confidence: "conservative".to_owned(),
        widened: false,
        project,
        causes: Vec::new(),
        reached_files: selected_files.clone(),
        selected_files,
        cache_inputs: None,
        read_guard_allowlist: Some(allowlist),
    }
}

fn synthetic_plan(tasks: Vec<TaskDecision>) -> PlanResult {
    let run_count = tasks.len();
    PlanResult {
        schema_version: PROTOCOL_SCHEMA_VERSION,
        scope: ResolvedScope {
            kind: "all".to_owned(),
            base: None,
            head: None,
            changed_paths: Vec::new(),
            full_fallback: false,
        },
        tasks,
        issues: Vec::new(),
        complete: true,
        counts: PlanCounts {
            run: run_count,
            skip_proven_unaffected: 0,
        },
        shard: None,
        workspace_fingerprint: None,
    }
}

fn matching_files_for_task(
    manifest: &TestingManifest,
    task: &DeclaredTask,
    narrowing: &FileNarrowing,
    candidate_files: &BTreeSet<String>,
) -> Vec<String> {
    let mut matches = Vec::new();
    for rel in candidate_files {
        if is_ignored_segment(rel) {
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
        let Some(owner) = deepest_project_for_path(&manifest.projects, rel) else {
            continue;
        };
        if owner.id != task.project {
            continue;
        }
        if !narrowing.suffixes.iter().any(|s| rel.ends_with(s)) {
            continue;
        }
        if narrowing.exclude_suffixes.iter().any(|e| rel.ends_with(e)) {
            continue;
        }
        if is_excluded_by_args(&task.execution.args, rel) {
            continue;
        }
        matches.push(rel.clone());
    }
    matches
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

fn is_ignored_segment(rel: &str) -> bool {
    rel.split('/').any(|seg| {
        matches!(
            seg,
            "node_modules" | "dist" | ".git" | "target" | "fixtures" | "__fixtures__" | "__mocks__"
        )
    })
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
