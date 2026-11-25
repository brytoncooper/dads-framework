//! Per-step chaos invariant verifier: Node + `tsc` soundness, cold-vs-incremental graph snapshot
//! parity, repeat cache integrity, and clean precision tracking.

use crate::dad_client::{
    DadInvocation, ExecutedTaskView, NativeRequestPayload, PlannedTaskView, invoke_dad,
};
use crate::fuzz_materialize::MaterializedChaosWorkspace;
use crate::fuzz_ops::ChaosLiveState;
use crate::fuzz_parity::{ParityCheckOutcome, check_cold_vs_incremental_parity};
use crate::fuzz_shrink::ShrunkChaosRepro;
use crate::node_oracle::{NodeOracleWorker, OracleTestOutcome, OracleTestSpec};
use crate::tsc_oracle::{TscOracleOutcome, TscOracleWorker};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChaosFailure {
    pub seed: u64,
    pub step: usize,
    pub kind: String,
    pub task_id: String,
    pub test_file: String,
    pub detail: String,
    pub projects: usize,
    pub modules: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kept_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shrunk: Option<ShrunkChaosRepro>,
}

#[derive(Debug, Default)]
pub struct ChaosStepOutcome {
    pub oracle_failures: usize,
    pub soundness_misses: usize,
    pub stale_cache_hits: usize,
    pub snapshot_parity_checks: usize,
    pub snapshot_parity_divergences: usize,
    pub cache_integrity_violations: usize,
    pub precision_checks: usize,
    pub precision_skips: usize,
    pub first_failure: Option<ChaosFailure>,
}

pub struct ChaosStepCheckCtx<'a> {
    pub dad_bin: &'a Path,
    pub node_dir: Option<&'a Path>,
    pub workspace_dir: &'a Path,
    pub shared_cache_dir: &'a Path,
    pub materialized: &'a MaterializedChaosWorkspace,
    pub live_state: &'a ChaosLiveState,
    pub seed: u64,
    pub step_idx: usize,
    pub projects_count: usize,
    pub modules_count: usize,
    pub is_clean_precision_step: bool,
}

struct StepOracles {
    node: BTreeMap<String, OracleTestOutcome>,
    tsc: BTreeMap<String, TscOracleOutcome>,
}

pub fn verify_chaos_step(
    ctx: &ChaosStepCheckCtx<'_>,
    node_oracle: &mut NodeOracleWorker,
    tsc_oracle: &mut TscOracleWorker,
) -> Result<ChaosStepOutcome, String> {
    let mut out = ChaosStepOutcome::default();
    let oracles = evaluate_oracles(ctx, node_oracle, tsc_oracle)?;

    let inc_run = invoke_chaos_run(ctx)?;
    let Some(inc_res) = &inc_run.envelope.result else {
        out.first_failure = Some(make_chaos_failure(
            ctx,
            "dad-run-error",
            "",
            "",
            format!("dad-test run error: {:?}", inc_run.envelope.error),
        ));
        return Ok(out);
    };

    if ctx.is_clean_precision_step {
        for task in &inc_res.plan.tasks {
            out.precision_checks += 1;
            if task.decision != "run" {
                out.precision_skips += 1;
            }
        }
    }

    check_soundness(ctx, &oracles.node, &oracles.tsc, inc_res, &mut out);
    match check_cold_vs_incremental_parity(
        ctx.dad_bin,
        ctx.node_dir,
        ctx.workspace_dir,
        &ctx.materialized.baseline_sha,
        &inc_res.plan.tasks,
    )? {
        ParityCheckOutcome::Matched => out.snapshot_parity_checks += 1,
        ParityCheckOutcome::Diverged { kind, detail } => {
            out.snapshot_parity_checks += 1;
            out.snapshot_parity_divergences += 1;
            if out.first_failure.is_none() {
                out.first_failure = Some(make_chaos_failure(ctx, kind, "plan", "", detail));
            }
        }
    }

    let oracle_had_failure =
        oracles.node.values().any(|o| !o.ok) || oracles.tsc.values().any(|o| !o.passed);
    if oracle_had_failure && out.soundness_misses == 0 {
        let repeat = invoke_chaos_run(ctx)?;
        check_repeat_cache_integrity(ctx, &oracles.node, &oracles.tsc, &repeat, &mut out);
    }
    Ok(out)
}

fn evaluate_oracles(
    ctx: &ChaosStepCheckCtx<'_>,
    node_oracle: &mut NodeOracleWorker,
    tsc_oracle: &mut TscOracleWorker,
) -> Result<StepOracles, String> {
    let mut specs: Vec<OracleTestSpec> = ctx
        .materialized
        .oracle_tests
        .iter()
        .cloned()
        .map(|mut s| {
            if let Some(val) = ctx.live_state.project_env_overrides.get(&s.file) {
                s.env.insert("CHAOS_ENV".to_owned(), val.clone());
            }
            s
        })
        .collect();
    for (_, extra) in &ctx.live_state.extra_task_tests {
        specs.push(extra.clone());
    }
    let node = node_oracle.evaluate(ctx.workspace_dir, &specs)?;
    let mut tsc = BTreeMap::new();
    for (task_id, tsconfig_rel) in &ctx.materialized.typecheck_tasks {
        let outcome = tsc_oracle.check(ctx.workspace_dir, tsconfig_rel)?;
        tsc.insert(task_id.clone(), outcome);
    }
    Ok(StepOracles { node, tsc })
}

fn check_soundness(
    ctx: &ChaosStepCheckCtx<'_>,
    node_outcomes: &BTreeMap<String, OracleTestOutcome>,
    tsc_outcomes: &BTreeMap<String, TscOracleOutcome>,
    res: &crate::dad_client::NativeResult,
    out: &mut ChaosStepOutcome,
) {
    let plan_by_id: BTreeMap<&str, &PlannedTaskView> =
        res.plan.tasks.iter().map(|t| (t.id.as_str(), t)).collect();
    let run_by_id: BTreeMap<&str, &ExecutedTaskView> = res
        .run
        .as_ref()
        .map(|r| r.tasks.iter().map(|t| (t.id.as_str(), t)).collect())
        .unwrap_or_default();

    for (task_id, files) in &ctx.materialized.task_tests {
        for file in files {
            if node_outcomes.get(file).is_some_and(|o| !o.ok) {
                record_if_missed(ctx, task_id, file, true, &plan_by_id, &run_by_id, out);
            }
        }
    }
    for (task_id, extra) in &ctx.live_state.extra_task_tests {
        if node_outcomes.get(&extra.file).is_some_and(|o| !o.ok) {
            record_if_missed(
                ctx,
                task_id,
                &extra.file,
                true,
                &plan_by_id,
                &run_by_id,
                out,
            );
        }
    }
    for (task_id, tc) in tsc_outcomes {
        if !tc.passed {
            let tsconfig = ctx
                .materialized
                .typecheck_tasks
                .get(task_id)
                .map(String::as_str)
                .unwrap_or("tsconfig.json");
            record_if_missed(ctx, task_id, tsconfig, false, &plan_by_id, &run_by_id, out);
        }
    }
}

fn record_if_missed(
    ctx: &ChaosStepCheckCtx<'_>,
    task_id: &str,
    file: &str,
    check_selected_files: bool,
    plan_by_id: &BTreeMap<&str, &PlannedTaskView>,
    run_by_id: &BTreeMap<&str, &ExecutedTaskView>,
    out: &mut ChaosStepOutcome,
) {
    out.oracle_failures += 1;
    let miss = match plan_by_id.get(task_id) {
        None => Some(("missing-task", format!("{task_id} absent from plan"))),
        Some(planned) if planned.decision != "run" => Some((
            "skipped-failing-task",
            format!("decision={} reason={}", planned.decision, planned.reason),
        )),
        Some(planned)
            if check_selected_files
                && !planned.selected_files.is_empty()
                && !planned.selected_files.iter().any(|f| f == file) =>
        {
            Some((
                "narrowed-past-failing-test",
                format!("selectedFiles={:?} omitted {file}", planned.selected_files),
            ))
        }
        Some(_) => match run_by_id.get(task_id) {
            None => Some(("not-executed", format!("{task_id} absent from run results"))),
            Some(exec) if exec.cached => Some((
                "stale-cache-hit",
                format!("{task_id} returned CACHED pass despite oracle failure in {file}"),
            )),
            Some(exec) if exec.status != "failed" && exec.exit_code == Some(0) => Some((
                "passed-unexpectedly",
                format!("{task_id} status={} exit={:?}", exec.status, exec.exit_code),
            )),
            Some(_) => None,
        },
    };
    if let Some((kind, detail)) = miss {
        out.soundness_misses += 1;
        if kind == "stale-cache-hit" {
            out.stale_cache_hits += 1;
        }
        if out.first_failure.is_none() {
            out.first_failure = Some(make_chaos_failure(ctx, kind, task_id, file, detail));
        }
    }
}

fn check_repeat_cache_integrity(
    ctx: &ChaosStepCheckCtx<'_>,
    node_outcomes: &BTreeMap<String, OracleTestOutcome>,
    tsc_outcomes: &BTreeMap<String, TscOracleOutcome>,
    repeat: &DadInvocation,
    out: &mut ChaosStepOutcome,
) {
    let Some(run) = repeat.envelope.result.as_ref().and_then(|r| r.run.as_ref()) else {
        return;
    };
    let mut failing_tasks: Vec<(&str, &str)> = Vec::new();
    for (task_id, files) in &ctx.materialized.task_tests {
        if let Some(f) = files
            .iter()
            .find(|f| node_outcomes.get(*f).is_some_and(|o| !o.ok))
        {
            failing_tasks.push((task_id.as_str(), f.as_str()));
        }
    }
    for (task_id, extra) in &ctx.live_state.extra_task_tests {
        if node_outcomes.get(&extra.file).is_some_and(|o| !o.ok) {
            failing_tasks.push((task_id.as_str(), extra.file.as_str()));
        }
    }
    for (task_id, tc) in tsc_outcomes {
        if !tc.passed {
            failing_tasks.push((task_id.as_str(), "tsconfig.json"));
        }
    }
    for (task_id, file) in failing_tasks {
        if let Some(exec) = run.tasks.iter().find(|t| t.id == task_id)
            && (exec.cached || (exec.status != "failed" && exec.exit_code == Some(0)))
        {
            out.cache_integrity_violations += 1;
            if out.first_failure.is_none() {
                let detail = format!(
                    "repeat run returned cached={} status={} exit={:?}",
                    exec.cached, exec.status, exec.exit_code
                );
                out.first_failure = Some(make_chaos_failure(
                    ctx,
                    "failed-task-cached",
                    task_id,
                    file,
                    detail,
                ));
            }
        }
    }
}

fn invoke_chaos_run(ctx: &ChaosStepCheckCtx<'_>) -> Result<DadInvocation, String> {
    let mut req =
        NativeRequestPayload::new("run", ctx.workspace_dir.to_string_lossy().into_owned());
    req.base = Some(ctx.materialized.baseline_sha.clone());
    req.cache = true;
    req.cache_dir = Some(ctx.shared_cache_dir.to_string_lossy().into_owned());
    invoke_dad(ctx.dad_bin, &req, ctx.node_dir)
}

fn make_chaos_failure(
    ctx: &ChaosStepCheckCtx<'_>,
    kind: &str,
    task_id: &str,
    test_file: &str,
    detail: String,
) -> ChaosFailure {
    ChaosFailure {
        seed: ctx.seed,
        step: ctx.step_idx,
        kind: kind.to_owned(),
        task_id: task_id.to_owned(),
        test_file: test_file.to_owned(),
        detail,
        projects: ctx.projects_count,
        modules: ctx.modules_count,
        kept_dir: None,
        shrunk: None,
    }
}
