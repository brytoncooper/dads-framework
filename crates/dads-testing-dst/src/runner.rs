//! Parallel seeded DST executor using APFS CoW baseline templates and real Node 24 + `tsc` oracles.

use crate::generator::pick_workspace_shape;
use crate::generator_lifecycle::set_file_mode;
use crate::generator_section_a::reset_section_a_untracked_baseline;
use crate::generator_subsystems::reset_subsystems_untracked_baseline;
use crate::invariants::{WorkerAccumulator, merge_accumulator};
use crate::model::{DstSummary, MutationKind, SoundnessFailure, WorkspaceShape};
use crate::mutations::{git_reset_clean, run_build_dep_script};
use crate::node_oracle::NodeOracleWorker;
use crate::rng::SeededRng;
use crate::runner_step::{StepRunInput, run_mutation_step};
use crate::template_cache::TemplateCache;
use crate::tsc_oracle::{TscOracleWorker, find_typescript_js};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::Instant;

#[derive(Debug, Clone)]
pub struct DstConfig {
    pub dad_bin: PathBuf,
    pub node_bin: PathBuf,
    pub scenarios: usize,
    pub steps_per_scenario: usize,
    pub base_seed: u64,
    pub jobs: usize,
    pub keep_failed: bool,
    pub max_sample_failures: usize,
    pub filter_mutation: Option<MutationKind>,
}

pub(crate) struct ScenarioPaths {
    pub(crate) temp_root: PathBuf,
    pub(crate) workspace_dir: PathBuf,
    pub(crate) shared_cache_dir: PathBuf,
    pub(crate) external_flag_path: PathBuf,
    pub(crate) symlink_target_path: PathBuf,
}

struct TimelineInput<'a> {
    config: &'a DstConfig,
    scenario_index: usize,
    paths: &'a ScenarioPaths,
    shape: &'a WorkspaceShape,
    node_dir: Option<&'a Path>,
    template_cache: &'a TemplateCache,
}

pub fn run_dst_sweep(config: &DstConfig) -> Result<DstSummary, String> {
    let started = Instant::now();
    let typescript_js = find_typescript_js()?;
    let template_cache = TemplateCache::new(
        config.dad_bin.clone(),
        config.node_bin.clone(),
        typescript_js.clone(),
    )?;
    let workers = config.jobs.max(1).min(config.scenarios.max(1));
    let next_index = AtomicUsize::new(0);

    let worker_results: Vec<Result<WorkerAccumulator, String>> = thread::scope(|scope| {
        let mut handles = Vec::with_capacity(workers);
        for _ in 0..workers {
            handles.push(
                scope.spawn(|| run_worker(config, &typescript_js, &template_cache, &next_index)),
            );
        }
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .map_err(|_| "DST worker thread panicked".to_owned())?
            })
            .collect()
    });

    let mut summary = DstSummary::default();
    for worker_result in worker_results {
        let acc = worker_result?;
        merge_accumulator(&mut summary, acc, config.max_sample_failures);
    }
    summary.elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    Ok(summary)
}

fn run_worker(
    config: &DstConfig,
    typescript_js: &Path,
    template_cache: &TemplateCache,
    next_index: &AtomicUsize,
) -> Result<WorkerAccumulator, String> {
    let mut oracle = NodeOracleWorker::spawn(&config.node_bin, typescript_js)?;
    let mut tsc_oracle = TscOracleWorker::spawn(&config.node_bin, typescript_js)?;
    let mut acc = WorkerAccumulator::default();
    let node_dir = config.node_bin.parent();

    loop {
        let index = next_index.fetch_add(1, Ordering::Relaxed);
        if index >= config.scenarios {
            break;
        }
        let seed = config
            .base_seed
            .wrapping_add(u64::try_from(index).unwrap_or(0));
        if let Err(error) = run_one_scenario(
            config,
            index,
            seed,
            node_dir,
            template_cache,
            &mut WorkerOracles {
                node: &mut oracle,
                tsc: &mut tsc_oracle,
            },
            &mut acc,
        ) {
            acc.harness_errors += 1;
            if acc.sample_failures.len() < config.max_sample_failures {
                acc.sample_failures.push(SoundnessFailure {
                    seed,
                    step: 0,
                    mutation: config
                        .filter_mutation
                        .unwrap_or(MutationKind::ALL[index % MutationKind::ALL.len()]),
                    kind: "harness-error".to_owned(),
                    task_id: String::new(),
                    test_file: String::new(),
                    detail: error,
                    shape: pick_workspace_shape(seed, &mut SeededRng::new(seed)),
                    kept_dir: None,
                });
            }
        }
    }
    Ok(acc)
}

struct WorkerOracles<'a> {
    node: &'a mut NodeOracleWorker,
    tsc: &'a mut TscOracleWorker,
}

fn run_one_scenario(
    config: &DstConfig,
    scenario_index: usize,
    seed: u64,
    node_dir: Option<&Path>,
    template_cache: &TemplateCache,
    oracles: &mut WorkerOracles<'_>,
    acc: &mut WorkerAccumulator,
) -> Result<(), String> {
    let mut rng = SeededRng::new(seed);
    let shape = pick_workspace_shape(seed, &mut rng);
    let temp_root = create_scenario_dir(seed, scenario_index)?;
    let paths = ScenarioPaths {
        workspace_dir: temp_root.join("ws"),
        shared_cache_dir: temp_root.join("shared-cache"),
        external_flag_path: temp_root.join("external-flag.txt"),
        symlink_target_path: temp_root.join("symlink-target.json"),
        temp_root,
    };
    fs::write(&paths.external_flag_path, "ok\n").map_err(|e| format!("write ext flag: {e}"))?;

    let result = execute_scenario_timeline(
        &TimelineInput {
            config,
            scenario_index,
            paths: &paths,
            shape: &shape,
            node_dir,
            template_cache,
        },
        &mut rng,
        oracles,
        acc,
    );

    let failed_in_scenario = result.as_ref().is_ok_and(|had_failure| *had_failure);
    if !failed_in_scenario || !config.keep_failed {
        let _ = fs::remove_dir_all(&paths.temp_root);
    }
    result.map(|_| ())
}

fn execute_scenario_timeline(
    input: &TimelineInput<'_>,
    rng: &mut SeededRng,
    oracles: &mut WorkerOracles<'_>,
    acc: &mut WorkerAccumulator,
) -> Result<bool, String> {
    let cloned = input.template_cache.clone_for_scenario(
        input.shape,
        &input.paths.workspace_dir,
        &input.paths.shared_cache_dir,
        oracles.node,
        oracles.tsc,
    )?;

    let mut had_failure = false;
    let steps = input.config.steps_per_scenario.max(1);
    for step_idx in 0..steps {
        if step_idx > 0 {
            reset_scenario_between_steps(input, &cloned.baseline_sha)?;
        }
        let mutation = pick_mutation(
            input.config.filter_mutation,
            input.scenario_index,
            step_idx,
            rng,
        );
        let step_failed = run_mutation_step(
            &StepRunInput {
                config: input.config,
                paths: input.paths,
                baseline_sha: &cloned.baseline_sha,
                generated: &cloned.generated,
                mutation,
                step_idx,
                node_dir: input.node_dir,
            },
            oracles.node,
            oracles.tsc,
            acc,
        )?;
        had_failure |= step_failed;
    }
    acc.scenarios_run += 1;
    Ok(had_failure)
}

fn reset_scenario_between_steps(
    input: &TimelineInput<'_>,
    baseline_sha: &str,
) -> Result<(), String> {
    let ws = &input.paths.workspace_dir;
    git_reset_clean(ws, baseline_sha)?;
    reset_section_a_untracked_baseline(ws)?;
    reset_subsystems_untracked_baseline(ws)?;
    set_file_mode(ws.join("settings/exec-flag.sh").as_path(), 0o644)?;
    fs::write(&input.paths.external_flag_path, "ok\n")
        .map_err(|e| format!("reset ext flag: {e}"))?;
    run_build_dep_script(&input.config.node_bin, ws)
}

fn pick_mutation(
    filter: Option<MutationKind>,
    scenario_index: usize,
    step_idx: usize,
    rng: &mut SeededRng,
) -> MutationKind {
    if let Some(kind) = filter {
        return kind;
    }
    if step_idx == 0 {
        return MutationKind::ALL[scenario_index % MutationKind::ALL.len()];
    }
    *rng.choose(MutationKind::ALL)
        .unwrap_or(&MutationKind::PureExportValue)
}

fn create_scenario_dir(seed: u64, index: usize) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(format!("dads-dst-{}-{index}-{seed}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).map_err(|e| format!("create scenario dir {}: {e}", dir.display()))?;
    Ok(dir)
}
