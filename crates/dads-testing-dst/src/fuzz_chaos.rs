//! Parallel generative random-graph chaos fuzzer with un-reset stateful timelines,
//! cold-vs-incremental parity checks, and automatic delta-debugging shrinking (`Section E`).

use crate::dad_client::{NativeRequestPayload, invoke_dad};
use crate::fuzz_apply::apply_chaos_step;
use crate::fuzz_graph::{ChaosWorkspaceSpec, generate_chaos_workspace};
use crate::fuzz_materialize::{ChaosMaterializeTools, materialize_chaos_workspace};
use crate::fuzz_ops::{ChaosLiveState, ChaosStep, generate_chaos_steps};
pub use crate::fuzz_report::{ChaosSummary, merge_chaos_summary, print_chaos_summary};
use crate::fuzz_shrink::shrink_chaos_failure;
use crate::fuzz_verify::{ChaosFailure, ChaosStepCheckCtx, verify_chaos_step};
use crate::node_oracle::{DST_RUNNER_JS, NodeOracleWorker};
use crate::tsc_oracle::{DST_TYPECHECK_JS, TscOracleWorker, find_typescript_js};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::thread;
use std::time::Instant;

static CHAOS_DIR_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
pub struct ChaosConfig {
    pub dad_bin: PathBuf,
    pub node_bin: PathBuf,
    pub scenarios: usize,
    pub steps_per_scenario: usize,
    pub base_seed: u64,
    pub jobs: usize,
    pub keep_failed: bool,
    pub shrink: bool,
    pub max_sample_failures: usize,
}

struct ChaosSharedScripts {
    root_dir: PathBuf,
    runner_script: PathBuf,
    typecheck_script: PathBuf,
    typescript_js: PathBuf,
}

impl Drop for ChaosSharedScripts {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root_dir);
    }
}

pub fn run_chaos_sweep(config: &ChaosConfig) -> Result<ChaosSummary, String> {
    let started = Instant::now();
    let scripts = prepare_shared_scripts()?;
    let workers = config.jobs.max(1).min(config.scenarios.max(1));
    let next_index = AtomicUsize::new(0);

    let worker_results: Vec<Result<ChaosSummary, String>> = thread::scope(|scope| {
        let mut handles = Vec::with_capacity(workers);
        for _ in 0..workers {
            handles.push(scope.spawn(|| run_chaos_worker(config, &scripts, &next_index)));
        }
        handles
            .into_iter()
            .map(|h| h.join().map_err(|_| "chaos worker panicked".to_owned())?)
            .collect()
    });

    let mut summary = ChaosSummary::default();
    for res in worker_results {
        merge_chaos_summary(&mut summary, res?, config.max_sample_failures);
    }
    summary.elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    Ok(summary)
}

fn prepare_shared_scripts() -> Result<ChaosSharedScripts, String> {
    let typescript_js = find_typescript_js()?;
    let seq = CHAOS_DIR_SEQ.fetch_add(1, Ordering::Relaxed);
    let root_dir =
        std::env::temp_dir().join(format!("dads-chaos-scripts-{}-{seq}", std::process::id()));
    let _ = fs::remove_dir_all(&root_dir);
    fs::create_dir_all(&root_dir).map_err(|e| format!("mkdir chaos scripts: {e}"))?;
    let runner_script = root_dir.join("dst-runner.mjs");
    let typecheck_script = root_dir.join("dst-typecheck.mjs");
    fs::write(&runner_script, DST_RUNNER_JS).map_err(|e| format!("write dst-runner.mjs: {e}"))?;
    fs::write(&typecheck_script, DST_TYPECHECK_JS)
        .map_err(|e| format!("write dst-typecheck.mjs: {e}"))?;
    Ok(ChaosSharedScripts {
        root_dir,
        runner_script,
        typecheck_script,
        typescript_js,
    })
}

fn run_chaos_worker(
    config: &ChaosConfig,
    scripts: &ChaosSharedScripts,
    next_index: &AtomicUsize,
) -> Result<ChaosSummary, String> {
    let mut node_oracle = NodeOracleWorker::spawn(&config.node_bin, &scripts.typescript_js)?;
    let mut tsc_oracle = TscOracleWorker::spawn(&config.node_bin, &scripts.typescript_js)?;
    let mut acc = ChaosSummary::default();

    loop {
        let index = next_index.fetch_add(1, Ordering::Relaxed);
        if index >= config.scenarios {
            break;
        }
        let seed = config
            .base_seed
            .wrapping_add(u64::try_from(index).unwrap_or(0));
        let spec = generate_chaos_workspace(seed);
        let steps = generate_chaos_steps(&spec, seed, config.steps_per_scenario.max(1));
        if let Err(err) = execute_one_chaos_scenario(
            config,
            scripts,
            &spec,
            &steps,
            &mut node_oracle,
            &mut tsc_oracle,
            &mut acc,
        ) {
            acc.harness_errors += 1;
            if acc.sample_failures.len() < config.max_sample_failures {
                acc.sample_failures.push(ChaosFailure {
                    seed,
                    step: 0,
                    kind: "harness-error".to_owned(),
                    task_id: String::new(),
                    test_file: String::new(),
                    detail: err,
                    projects: spec.projects.len(),
                    modules: spec.modules.len(),
                    kept_dir: None,
                    shrunk: None,
                });
            }
        }
    }
    Ok(acc)
}

struct ChaosTempGuard {
    dir: PathBuf,
    keep: bool,
}

impl Drop for ChaosTempGuard {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
}

fn execute_one_chaos_scenario(
    config: &ChaosConfig,
    scripts: &ChaosSharedScripts,
    spec: &ChaosWorkspaceSpec,
    steps: &[ChaosStep],
    node_oracle: &mut NodeOracleWorker,
    tsc_oracle: &mut TscOracleWorker,
    acc: &mut ChaosSummary,
) -> Result<(), String> {
    let temp_root = fresh_chaos_dir(spec.seed, "run")?;
    let mut temp_guard = ChaosTempGuard {
        dir: temp_root.clone(),
        keep: false,
    };
    let ws_dir = temp_root.join("ws");
    let cache_dir = temp_root.join("shared-cache");
    fs::create_dir_all(&cache_dir).map_err(|e| format!("mkdir chaos cache: {e}"))?;

    let tools = ChaosMaterializeTools {
        node_bin: &config.node_bin,
        runner_script: &scripts.runner_script,
        typecheck_script: &scripts.typecheck_script,
        typescript_js: &scripts.typescript_js,
    };
    let materialized = materialize_chaos_workspace(&ws_dir, spec, &tools, node_oracle)?;
    warm_chaos_baseline(config, &ws_dir, &cache_dir, &materialized.baseline_sha)?;

    let mut live_state = ChaosLiveState::default();
    let mut first_failure: Option<ChaosFailure> = None;
    let mut first_fail_step = 0usize;

    for (step_idx, step) in steps.iter().enumerate() {
        let is_clean_precision_step =
            apply_chaos_step(&ws_dir, &cache_dir, spec, step, &mut live_state)?;
        let outcome = verify_chaos_step(
            &ChaosStepCheckCtx {
                dad_bin: &config.dad_bin,
                node_dir: config.node_bin.parent(),
                workspace_dir: &ws_dir,
                shared_cache_dir: &cache_dir,
                materialized: &materialized,
                live_state: &live_state,
                seed: spec.seed,
                step_idx,
                projects_count: spec.projects.len(),
                modules_count: spec.modules.len(),
                is_clean_precision_step,
            },
            node_oracle,
            tsc_oracle,
        )?;
        acc.steps_executed += 1;
        acc.oracle_failures_total += outcome.oracle_failures;
        acc.soundness_misses_total += outcome.soundness_misses;
        acc.stale_cache_hits_total += outcome.stale_cache_hits;
        acc.snapshot_parity_checks += outcome.snapshot_parity_checks;
        acc.snapshot_parity_divergences += outcome.snapshot_parity_divergences;
        acc.cache_integrity_violations += outcome.cache_integrity_violations;
        acc.precision_checks_total += outcome.precision_checks;
        acc.precision_skips_total += outcome.precision_skips;
        if first_failure.is_none()
            && let Some(failure) = outcome.first_failure
        {
            first_failure = Some(failure);
            first_fail_step = step_idx;
        }
    }

    acc.scenarios_run += 1;
    if let Some(mut failure) = first_failure {
        if config.shrink {
            let target_kind = failure.kind.clone();
            let (_min_spec, shrunk) =
                shrink_chaos_failure(spec, steps, first_fail_step, 32, |cand_spec, cand_steps| {
                    reproduces_chaos_kind(
                        config,
                        scripts,
                        cand_spec,
                        cand_steps,
                        &target_kind,
                        node_oracle,
                        tsc_oracle,
                    )
                });
            failure.shrunk = Some(shrunk);
        }
        if config.keep_failed {
            temp_guard.keep = true;
            failure.kept_dir = Some(ws_dir.to_string_lossy().into_owned());
        }
        if acc.sample_failures.len() < config.max_sample_failures {
            acc.sample_failures.push(failure);
        }
    }
    Ok(())
}

fn reproduces_chaos_kind(
    config: &ChaosConfig,
    scripts: &ChaosSharedScripts,
    spec: &ChaosWorkspaceSpec,
    steps: &[ChaosStep],
    expected_kind: &str,
    node_oracle: &mut NodeOracleWorker,
    tsc_oracle: &mut TscOracleWorker,
) -> bool {
    let Ok(temp_root) = fresh_chaos_dir(spec.seed, "shrink") else {
        return false;
    };
    let ws_dir = temp_root.join("ws");
    let cache_dir = temp_root.join("shared-cache");
    let matched = (|| -> Result<bool, String> {
        fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
        let tools = ChaosMaterializeTools {
            node_bin: &config.node_bin,
            runner_script: &scripts.runner_script,
            typecheck_script: &scripts.typecheck_script,
            typescript_js: &scripts.typescript_js,
        };
        let materialized = materialize_chaos_workspace(&ws_dir, spec, &tools, node_oracle)?;
        warm_chaos_baseline(config, &ws_dir, &cache_dir, &materialized.baseline_sha)?;
        let mut live_state = ChaosLiveState::default();
        for (step_idx, step) in steps.iter().enumerate() {
            let is_clean = apply_chaos_step(&ws_dir, &cache_dir, spec, step, &mut live_state)?;
            let outcome = verify_chaos_step(
                &ChaosStepCheckCtx {
                    dad_bin: &config.dad_bin,
                    node_dir: config.node_bin.parent(),
                    workspace_dir: &ws_dir,
                    shared_cache_dir: &cache_dir,
                    materialized: &materialized,
                    live_state: &live_state,
                    seed: spec.seed,
                    step_idx,
                    projects_count: spec.projects.len(),
                    modules_count: spec.modules.len(),
                    is_clean_precision_step: is_clean,
                },
                node_oracle,
                tsc_oracle,
            )?;
            if outcome
                .first_failure
                .as_ref()
                .is_some_and(|f| f.kind == expected_kind)
            {
                return Ok(true);
            }
        }
        Ok(false)
    })();
    let _ = fs::remove_dir_all(&temp_root);
    matched.unwrap_or(false)
}

fn warm_chaos_baseline(
    config: &ChaosConfig,
    ws_dir: &Path,
    cache_dir: &Path,
    baseline_sha: &str,
) -> Result<(), String> {
    let ws_str = ws_dir.to_string_lossy().into_owned();
    let mut run_req = NativeRequestPayload::new("run", ws_str.clone());
    run_req.all = true;
    run_req.cache = true;
    run_req.cache_dir = Some(cache_dir.to_string_lossy().into_owned());
    let inv = invoke_dad(&config.dad_bin, &run_req, config.node_bin.parent())?;
    if !inv.envelope.ok || !inv.exit_ok {
        return Err(format!(
            "chaos baseline warm run failed: {:?}",
            inv.envelope.error
        ));
    }
    if let Some(run) = inv.envelope.result.as_ref().and_then(|r| r.run.as_ref()) {
        for t in &run.tasks {
            if t.status == "failed" || t.exit_code.is_some_and(|c| c != 0) {
                let err = t.stderr.as_ref().map(|s| s.text.trim()).unwrap_or("");
                return Err(format!("chaos baseline task {} failed: {err}", t.id));
            }
        }
    }
    let mut plan_req = NativeRequestPayload::new("plan", ws_str);
    plan_req.base = Some(baseline_sha.to_owned());
    let plan_inv = invoke_dad(&config.dad_bin, &plan_req, config.node_bin.parent())?;
    if !plan_inv.envelope.ok {
        return Err(format!(
            "chaos baseline plan seed failed: {:?}",
            plan_inv.envelope.error
        ));
    }
    Ok(())
}

fn fresh_chaos_dir(seed: u64, tag: &str) -> Result<PathBuf, String> {
    let seq = CHAOS_DIR_SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "dads-chaos-{tag}-{}-{seed}-{seq}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    Ok(dir)
}
