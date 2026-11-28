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
//!    equivalence classes with identical narrowed allowlists `A(G)` (zero sibling masking).
//! 3. Pass 3 runs ONLY failing groups of size > 1 one file at a time so every reported
//!    `UndeclaredRead` carries its exact `selected_file`.

use super::audit_per_file_plan::{
    audit_subrun_options, clone_plan, matching_files_for_task, record_reads_for_file,
    synthetic_audit_task, synthetic_plan, synthetic_run_decision, workspace_candidate_files,
};
use super::read_guard::should_guard_task;
use super::read_guard_allowlist::AllowlistBuilder;
use super::{RunOptions, run_plan_once};
use crate::execute::TestingError;
use crate::manifest::{DeclaredTask, TestingManifest};
use crate::protocol::{PlanResult, RunResult, TaskReadGuardAllowlist, UndeclaredRead};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

struct NarrowedTaskSpec {
    task_index: usize,
    task_id: String,
    matching_files: Vec<String>,
    per_file_allowlists: BTreeMap<String, TaskReadGuardAllowlist>,
}

type ConfirmedReadsByTask = BTreeMap<usize, BTreeSet<UndeclaredRead>>;

struct Pass3Candidate {
    orig_idx: usize,
    orig_id: String,
    group_idx: usize,
    files: Vec<String>,
    allowlist: TaskReadGuardAllowlist,
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
    let (pass1_plan, narrowed_specs) =
        build_pass1_plan(manifest, workspace_root, plan, &declared, options.graph);

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
    tag_single_file_reads(&narrowed_specs, &mut pass1_run);

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

    let (mut confirmed_by_task, pass3_candidates) = run_pass2_groups(
        manifest,
        workspace_root,
        manifest_file,
        &declared,
        &flagged_specs,
        &options,
    )?;

    if !pass3_candidates.is_empty() {
        run_pass3_single_files(
            manifest,
            workspace_root,
            manifest_file,
            &declared,
            &pass3_candidates,
            &options,
            &mut confirmed_by_task,
        )?;
    }

    for (orig_idx, reads) in confirmed_by_task {
        if let Some(task_result) = pass1_run.tasks.get_mut(orig_idx) {
            task_result.undeclared_reads = reads.into_iter().collect();
        }
    }
    Ok(pass1_run)
}

fn build_pass1_plan(
    manifest: &TestingManifest,
    workspace_root: &Path,
    plan: &PlanResult,
    declared: &BTreeMap<&str, &DeclaredTask>,
    graph: Option<&crate::graph::DependencyGraph>,
) -> (PlanResult, BTreeMap<String, NarrowedTaskSpec>) {
    let allowlist_builder = AllowlistBuilder::new(manifest, graph);
    let candidate_files = workspace_candidate_files(workspace_root);
    let mut pass1_plan = clone_plan(plan);
    let mut narrowed_specs = BTreeMap::new();

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
            decision.read_guard_allowlist =
                Some(allowlist_builder.for_task_parts(task, &decision.selected_files, None));
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
        decision.read_guard_allowlist =
            Some(TaskReadGuardAllowlist::intersect_many(per_file.values()));
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
    (pass1_plan, narrowed_specs)
}

fn tag_single_file_reads(
    narrowed_specs: &BTreeMap<String, NarrowedTaskSpec>,
    pass1_run: &mut RunResult,
) {
    for spec in narrowed_specs.values() {
        if spec.matching_files.len() != 1 {
            continue;
        }
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

fn run_pass2_groups(
    manifest: &TestingManifest,
    workspace_root: &Path,
    manifest_file: &Path,
    declared: &BTreeMap<&str, &DeclaredTask>,
    flagged_specs: &[&NarrowedTaskSpec],
    options: &RunOptions<'_>,
) -> Result<(ConfirmedReadsByTask, Vec<Pass3Candidate>), TestingError> {
    let mut pass2_manifest = manifest.clone();
    pass2_manifest.tasks.clear();
    let mut pass2_decisions = Vec::new();
    let mut pass2_meta = Vec::new();

    for spec in flagged_specs {
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
            pass2_manifest
                .tasks
                .push(synthetic_audit_task(base_task, synth_id.clone()));
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
        audit_subrun_options(options),
    )?;

    let mut confirmed_by_task: BTreeMap<usize, BTreeSet<UndeclaredRead>> = flagged_specs
        .iter()
        .map(|spec| (spec.task_index, BTreeSet::new()))
        .collect();
    let mut pass3_candidates = Vec::new();

    for (idx, group_result) in pass2_run.tasks.iter().enumerate() {
        if group_result.undeclared_reads.is_empty() {
            continue;
        }
        let (orig_idx, orig_id, files, allowlist) = &pass2_meta[idx];
        if files.len() == 1 {
            record_reads_for_file(
                confirmed_by_task.entry(*orig_idx).or_default(),
                &group_result.undeclared_reads,
                &files[0],
            );
        } else {
            pass3_candidates.push(Pass3Candidate {
                orig_idx: *orig_idx,
                orig_id: orig_id.clone(),
                group_idx: idx,
                files: files.clone(),
                allowlist: allowlist.clone(),
            });
        }
    }
    Ok((confirmed_by_task, pass3_candidates))
}

fn run_pass3_single_files(
    manifest: &TestingManifest,
    workspace_root: &Path,
    manifest_file: &Path,
    declared: &BTreeMap<&str, &DeclaredTask>,
    candidates: &[Pass3Candidate],
    options: &RunOptions<'_>,
    confirmed_by_task: &mut ConfirmedReadsByTask,
) -> Result<(), TestingError> {
    let mut pass3_manifest = manifest.clone();
    pass3_manifest.tasks.clear();
    let mut pass3_decisions = Vec::new();
    let mut pass3_meta = Vec::new();

    for candidate in candidates {
        let Some(&base_task) = declared.get(candidate.orig_id.as_str()) else {
            continue;
        };
        for (file_idx, file) in candidate.files.iter().enumerate() {
            let synth_id = format!(
                "{}#audit-file-{}-{file_idx}",
                candidate.orig_id, candidate.group_idx
            );
            pass3_manifest
                .tasks
                .push(synthetic_audit_task(base_task, synth_id.clone()));
            pass3_decisions.push(synthetic_run_decision(
                synth_id,
                base_task.project.clone(),
                vec![file.clone()],
                candidate.allowlist.clone(),
            ));
            pass3_meta.push((candidate.orig_idx, file.clone()));
        }
    }

    let pass3_plan = synthetic_plan(pass3_decisions);
    let pass3_run = run_plan_once(
        &pass3_manifest,
        workspace_root,
        manifest_file,
        &pass3_plan,
        audit_subrun_options(options),
    )?;
    for (idx, file_result) in pass3_run.tasks.iter().enumerate() {
        if file_result.undeclared_reads.is_empty() {
            continue;
        }
        let (orig_idx, file) = &pass3_meta[idx];
        record_reads_for_file(
            confirmed_by_task.entry(*orig_idx).or_default(),
            &file_result.undeclared_reads,
            file,
        );
    }
    Ok(())
}
