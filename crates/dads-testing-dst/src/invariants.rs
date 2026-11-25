//! Soundness, cache-integrity, and precision invariant verification for DST steps.

use crate::dad_client::{DadInvocation, ExecutedTaskView, PlannedTaskView};
use crate::generator::GeneratedWorkspace;
use crate::model::{DstSummary, MutationKind, MutationStats, SoundnessFailure};
use crate::node_oracle::OracleTestOutcome;
use crate::runner::DstConfig;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Default)]
pub struct WorkerAccumulator {
    pub scenarios_run: usize,
    pub steps_executed: usize,
    pub oracle_failures_total: usize,
    pub soundness_misses_total: usize,
    pub stale_cache_hits_total: usize,
    pub cache_integrity_violations: usize,
    pub harness_errors: usize,
    pub precision_checks_total: usize,
    pub precision_skips_total: usize,
    pub by_mutation: BTreeMap<String, MutationStats>,
    pub sample_failures: Vec<SoundnessFailure>,
}

pub struct StepCheckCtx<'a> {
    pub config: &'a DstConfig,
    pub workspace_dir: &'a Path,
    pub generated: &'a GeneratedWorkspace,
    pub mutation: MutationKind,
    pub step_idx: usize,
    pub oracle_outcomes: &'a BTreeMap<String, OracleTestOutcome>,
}

pub fn verify_step_invariants(
    ctx: &StepCheckCtx<'_>,
    invocation: &DadInvocation,
    acc: &mut WorkerAccumulator,
) -> bool {
    let stats = acc
        .by_mutation
        .entry(ctx.mutation.as_str().to_owned())
        .or_default();
    stats.steps += 1;

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

    if ctx.mutation.is_precision_noop() {
        for task in &result.plan.tasks {
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

    let mut had_miss = false;
    for (task_id, files) in &ctx.generated.task_tests {
        for test_file in files {
            let failed_in_oracle = ctx.oracle_outcomes.get(test_file).is_some_and(|o| !o.ok);
            if !failed_in_oracle {
                continue;
            }
            stats.oracle_failures += 1;
            acc.oracle_failures_total += 1;
            if let Some((miss_kind, detail)) =
                check_task_caught_failure(task_id, test_file, &plan_by_id, &run_by_id)
            {
                had_miss = true;
                stats.soundness_misses += 1;
                acc.soundness_misses_total += 1;
                if miss_kind == "stale-cache-hit" {
                    stats.stale_cache_hits += 1;
                    acc.stale_cache_hits_total += 1;
                }
                if acc.sample_failures.len() < ctx.config.max_sample_failures {
                    acc.sample_failures.push(SoundnessFailure {
                        seed: ctx.generated.shape.seed,
                        step: ctx.step_idx,
                        mutation: ctx.mutation,
                        kind: miss_kind.to_owned(),
                        task_id: task_id.clone(),
                        test_file: test_file.clone(),
                        detail,
                        shape: ctx.generated.shape.clone(),
                        kept_dir: ctx
                            .config
                            .keep_failed
                            .then(|| ctx.workspace_dir.to_string_lossy().into_owned()),
                    });
                }
            }
        }
    }
    had_miss
}

pub fn verify_failed_not_cached(
    ctx: &StepCheckCtx<'_>,
    repeat: &DadInvocation,
    acc: &mut WorkerAccumulator,
) -> bool {
    let Some(result) = &repeat.envelope.result else {
        return false;
    };
    let Some(run) = &result.run else {
        return false;
    };
    let mut violated = false;
    for (task_id, files) in &ctx.generated.task_tests {
        let failing_file = files
            .iter()
            .find(|f| ctx.oracle_outcomes.get(*f).is_some_and(|o| !o.ok));
        let Some(test_file) = failing_file else {
            continue;
        };
        if let Some(executed) = run.tasks.iter().find(|t| t.id == *task_id)
            && (executed.cached || (executed.status != "failed" && executed.exit_code == Some(0)))
        {
            violated = true;
            acc.cache_integrity_violations += 1;
            if acc.sample_failures.len() < ctx.config.max_sample_failures {
                acc.sample_failures.push(SoundnessFailure {
                    seed: ctx.generated.shape.seed,
                    step: ctx.step_idx,
                    mutation: ctx.mutation,
                    kind: "failed-task-cached".to_owned(),
                    task_id: task_id.clone(),
                    test_file: test_file.clone(),
                    detail: format!(
                        "repeat run returned cached={} status={} exit={:?}",
                        executed.cached, executed.status, executed.exit_code
                    ),
                    shape: ctx.generated.shape.clone(),
                    kept_dir: ctx
                        .config
                        .keep_failed
                        .then(|| ctx.workspace_dir.to_string_lossy().into_owned()),
                });
            }
        }
    }
    violated
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
    acc.cache_integrity_violations += 1;
    if acc.sample_failures.len() < ctx.config.max_sample_failures {
        acc.sample_failures.push(SoundnessFailure {
            seed: ctx.generated.shape.seed,
            step: ctx.step_idx,
            mutation: ctx.mutation,
            kind: "batch-isolation-violation".to_owned(),
            task_id: "unrelated:test".to_owned(),
            test_file: "unrelated/control.test.ts".to_owned(),
            detail: format!("planned_ok={planned_ok} executed={executed:?}"),
            shape: ctx.generated.shape.clone(),
            kept_dir: ctx
                .config
                .keep_failed
                .then(|| ctx.workspace_dir.to_string_lossy().into_owned()),
        });
    }
    true
}

pub fn merge_accumulator(summary: &mut DstSummary, acc: WorkerAccumulator, max_samples: usize) {
    summary.scenarios_run += acc.scenarios_run;
    summary.steps_executed += acc.steps_executed;
    summary.oracle_failures_total += acc.oracle_failures_total;
    summary.soundness_misses_total += acc.soundness_misses_total;
    summary.stale_cache_hits_total += acc.stale_cache_hits_total;
    summary.cache_integrity_violations += acc.cache_integrity_violations;
    summary.harness_errors += acc.harness_errors;
    summary.precision_checks_total += acc.precision_checks_total;
    summary.precision_skips_total += acc.precision_skips_total;
    for (name, stats) in acc.by_mutation {
        let entry = summary.by_mutation.entry(name).or_default();
        entry.steps += stats.steps;
        entry.oracle_failures += stats.oracle_failures;
        entry.soundness_misses += stats.soundness_misses;
        entry.stale_cache_hits += stats.stale_cache_hits;
        entry.precision_checks += stats.precision_checks;
        entry.precision_skips += stats.precision_skips;
    }
    for failure in acc.sample_failures {
        if summary.sample_failures.len() < max_samples {
            summary.sample_failures.push(failure);
        }
    }
}

fn check_task_caught_failure(
    task_id: &str,
    test_file: &str,
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
    if !planned.selected_files.is_empty() && !planned.selected_files.iter().any(|f| f == test_file)
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
