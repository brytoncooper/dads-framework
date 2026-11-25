//! Soundness, cache-integrity, typecheck, and precision invariant verification for 93-family DST.

use crate::dad_client::{DadInvocation, ExecutedTaskView, PlannedTaskView};
use crate::generator::GeneratedWorkspace;
pub use crate::invariants_report::{
    FailureRecord, WorkerAccumulator, merge_accumulator, record_cache_integrity_violation,
    record_soundness_miss,
};
use crate::model::MutationKind;
use crate::node_oracle::OracleTestOutcome;
use crate::runner::DstConfig;
use crate::tsc_oracle::TscOracleOutcome;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub struct StepCheckCtx<'a> {
    pub config: &'a DstConfig,
    pub workspace_dir: &'a Path,
    pub generated: &'a GeneratedWorkspace,
    pub mutation: MutationKind,
    pub step_idx: usize,
    pub oracle_outcomes: &'a BTreeMap<String, OracleTestOutcome>,
    pub tsc_outcomes: &'a BTreeMap<String, TscOracleOutcome>,
    pub extra_task_tests: &'a [(String, String)],
    pub deleted_test_files: &'a [String],
    pub expected_skipped_tasks: &'a [String],
}

pub fn verify_step_invariants(
    ctx: &StepCheckCtx<'_>,
    invocation: &DadInvocation,
    acc: &mut WorkerAccumulator,
) -> bool {
    acc.by_mutation
        .entry(ctx.mutation.as_str().to_owned())
        .or_default()
        .steps += 1;

    let Some(result) = &invocation.envelope.result else {
        acc.harness_errors += 1;
        return true;
    };
    let plan_by_id: BTreeMap<&str, &PlannedTaskView> = result
        .plan
        .tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect();
    let run_by_id: BTreeMap<&str, &ExecutedTaskView> = result
        .run
        .as_ref()
        .map(|run| {
            run.tasks
                .iter()
                .map(|task| (task.id.as_str(), task))
                .collect()
        })
        .unwrap_or_default();

    record_precision_stats(ctx, &result.plan.tasks, &plan_by_id, acc);

    let deleted: BTreeSet<&str> = ctx.deleted_test_files.iter().map(String::as_str).collect();
    let mut had_miss = false;
    for (task_id, files) in &ctx.generated.task_tests {
        for test_file in files {
            if !deleted.contains(test_file.as_str()) {
                had_miss |=
                    check_node_test_failure(ctx, task_id, test_file, &plan_by_id, &run_by_id, acc);
            }
        }
    }
    for (task_id, test_file) in ctx.extra_task_tests {
        had_miss |= check_node_test_failure(ctx, task_id, test_file, &plan_by_id, &run_by_id, acc);
    }
    for (task_id, outcome) in ctx.tsc_outcomes {
        if !outcome.passed {
            had_miss |= check_tsc_task_failure(ctx, task_id, &plan_by_id, &run_by_id, acc);
        }
    }
    had_miss
}

fn check_node_test_failure(
    ctx: &StepCheckCtx<'_>,
    task_id: &str,
    test_file: &str,
    plan_by_id: &BTreeMap<&str, &PlannedTaskView>,
    run_by_id: &BTreeMap<&str, &ExecutedTaskView>,
    acc: &mut WorkerAccumulator,
) -> bool {
    if ctx.oracle_outcomes.get(test_file).is_none_or(|o| o.ok) {
        return false;
    }
    bump_oracle_failure(ctx.mutation, acc);
    if let Some((miss_kind, detail)) =
        check_task_caught_failure(task_id, test_file, true, plan_by_id, run_by_id)
    {
        record_soundness_miss(
            FailureRecord {
                config: ctx.config,
                workspace_dir: ctx.workspace_dir,
                shape: &ctx.generated.shape,
                step_idx: ctx.step_idx,
                mutation: ctx.mutation,
                kind: miss_kind,
                task_id,
                test_file,
                detail,
            },
            miss_kind == "stale-cache-hit",
            acc,
        );
        return true;
    }
    false
}

fn check_tsc_task_failure(
    ctx: &StepCheckCtx<'_>,
    task_id: &str,
    plan_by_id: &BTreeMap<&str, &PlannedTaskView>,
    run_by_id: &BTreeMap<&str, &ExecutedTaskView>,
    acc: &mut WorkerAccumulator,
) -> bool {
    bump_oracle_failure(ctx.mutation, acc);
    let tsconfig = ctx
        .generated
        .typecheck_tasks
        .get(task_id)
        .map(String::as_str)
        .unwrap_or("tsconfig.json");
    if let Some((miss_kind, detail)) =
        check_task_caught_failure(task_id, tsconfig, false, plan_by_id, run_by_id)
    {
        record_soundness_miss(
            FailureRecord {
                config: ctx.config,
                workspace_dir: ctx.workspace_dir,
                shape: &ctx.generated.shape,
                step_idx: ctx.step_idx,
                mutation: ctx.mutation,
                kind: miss_kind,
                task_id,
                test_file: tsconfig,
                detail,
            },
            miss_kind == "stale-cache-hit",
            acc,
        );
        return true;
    }
    false
}

fn bump_oracle_failure(mutation: MutationKind, acc: &mut WorkerAccumulator) {
    acc.by_mutation
        .entry(mutation.as_str().to_owned())
        .or_default()
        .oracle_failures += 1;
    acc.oracle_failures_total += 1;
}

fn record_precision_stats(
    ctx: &StepCheckCtx<'_>,
    planned_tasks: &[PlannedTaskView],
    plan_by_id: &BTreeMap<&str, &PlannedTaskView>,
    acc: &mut WorkerAccumulator,
) {
    let stats = acc
        .by_mutation
        .entry(ctx.mutation.as_str().to_owned())
        .or_default();
    if ctx.mutation.is_precision_noop() {
        for task in planned_tasks {
            if task.id == "adv-always:test" {
                continue;
            }
            stats.precision_checks += 1;
            acc.precision_checks_total += 1;
            if task.decision != "run" {
                stats.precision_skips += 1;
                acc.precision_skips_total += 1;
            }
        }
    }
    for task_id in ctx.expected_skipped_tasks {
        if let Some(task) = plan_by_id.get(task_id.as_str()) {
            stats.precision_checks += 1;
            acc.precision_checks_total += 1;
            if task.decision != "run" {
                stats.precision_skips += 1;
                acc.precision_skips_total += 1;
            }
        }
    }
}

pub fn verify_failed_not_cached(
    ctx: &StepCheckCtx<'_>,
    repeat: &DadInvocation,
    acc: &mut WorkerAccumulator,
) -> bool {
    let Some(run) = repeat.envelope.result.as_ref().and_then(|r| r.run.as_ref()) else {
        return false;
    };
    let mut violated = false;
    for (task_id, files) in &ctx.generated.task_tests {
        let failing_file = files
            .iter()
            .find(|f| ctx.oracle_outcomes.get(*f).is_some_and(|o| !o.ok))
            .map(String::as_str)
            .or_else(|| {
                ctx.extra_task_tests
                    .iter()
                    .find(|(tid, f)| {
                        tid == task_id && ctx.oracle_outcomes.get(f).is_some_and(|o| !o.ok)
                    })
                    .map(|(_, f)| f.as_str())
            });
        if let Some(test_file) = failing_file {
            violated |= check_repeat_not_cached(ctx, task_id, test_file, &run.tasks, acc);
        }
    }
    for (task_id, outcome) in ctx.tsc_outcomes {
        if !outcome.passed {
            let tsconfig = ctx
                .generated
                .typecheck_tasks
                .get(task_id)
                .map(String::as_str)
                .unwrap_or("tsconfig.json");
            violated |= check_repeat_not_cached(ctx, task_id, tsconfig, &run.tasks, acc);
        }
    }
    violated
}

fn check_repeat_not_cached(
    ctx: &StepCheckCtx<'_>,
    task_id: &str,
    test_file: &str,
    executed_tasks: &[ExecutedTaskView],
    acc: &mut WorkerAccumulator,
) -> bool {
    if let Some(executed) = executed_tasks.iter().find(|t| t.id == task_id)
        && (executed.cached || (executed.status != "failed" && executed.exit_code == Some(0)))
    {
        record_cache_integrity_violation(
            FailureRecord {
                config: ctx.config,
                workspace_dir: ctx.workspace_dir,
                shape: &ctx.generated.shape,
                step_idx: ctx.step_idx,
                mutation: ctx.mutation,
                kind: "failed-task-cached",
                task_id,
                test_file,
                detail: format!(
                    "repeat run returned cached={} status={} exit={:?}",
                    executed.cached, executed.status, executed.exit_code
                ),
            },
            acc,
        );
        return true;
    }
    false
}

pub fn verify_unrelated_batch_isolation(
    ctx: &StepCheckCtx<'_>,
    invocation: &DadInvocation,
    acc: &mut WorkerAccumulator,
) -> bool {
    let Some(result) = &invocation.envelope.result else {
        return false;
    };
    let Some(run) = &result.run else {
        return false;
    };
    let planned_ok = result
        .plan
        .tasks
        .iter()
        .find(|t| t.id == "unrelated:test")
        .is_some_and(|t| t.decision == "run");
    let executed = run.tasks.iter().find(|t| t.id == "unrelated:test");
    let passed_ok =
        executed.is_some_and(|t| t.status != "failed" && (t.cached || t.exit_code == Some(0)));
    if planned_ok && passed_ok {
        return false;
    }
    record_cache_integrity_violation(
        FailureRecord {
            config: ctx.config,
            workspace_dir: ctx.workspace_dir,
            shape: &ctx.generated.shape,
            step_idx: ctx.step_idx,
            mutation: ctx.mutation,
            kind: "batch-isolation-violation",
            task_id: "unrelated:test",
            test_file: "unrelated/control.test.ts",
            detail: format!("planned_ok={planned_ok} executed={executed:?}"),
        },
        acc,
    );
    true
}

fn check_task_caught_failure(
    task_id: &str,
    test_file: &str,
    check_selected_files: bool,
    plan_by_id: &BTreeMap<&str, &PlannedTaskView>,
    run_by_id: &BTreeMap<&str, &ExecutedTaskView>,
) -> Option<(&'static str, String)> {
    let Some(planned) = plan_by_id.get(task_id) else {
        return Some(("missing-task", format!("{task_id} absent from plan")));
    };
    if planned.decision != "run" {
        return Some((
            "skipped-failing-task",
            format!("decision={} reason={}", planned.decision, planned.reason),
        ));
    }
    if check_selected_files
        && !planned.selected_files.is_empty()
        && !planned.selected_files.iter().any(|f| f == test_file)
    {
        return Some((
            "narrowed-past-failing-test",
            format!(
                "selectedFiles={:?} omitted {test_file}",
                planned.selected_files
            ),
        ));
    }
    let Some(executed) = run_by_id.get(task_id) else {
        return Some(("not-executed", format!("{task_id} absent from run results")));
    };
    if executed.cached {
        return Some((
            "stale-cache-hit",
            format!("{task_id} returned CACHED pass despite oracle failure in {test_file}"),
        ));
    }
    if executed.status != "failed" && executed.exit_code == Some(0) {
        return Some((
            "passed-unexpectedly",
            format!(
                "{task_id} status={} exit={:?} despite oracle failure in {test_file}",
                executed.status, executed.exit_code
            ),
        ));
    }
    None
}
