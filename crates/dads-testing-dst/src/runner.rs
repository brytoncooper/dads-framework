//! Parallel seeded DST executor comparing real `dad-test` runs against the real Node 24 oracle.

use crate::dad_client::{DadInvocation, NativeRequestPayload, invoke_dad};
use crate::generator::{GeneratedWorkspace, generate_workspace, pick_workspace_shape};
use crate::invariants::{
    StepCheckCtx, WorkerAccumulator, merge_accumulator, verify_failed_not_cached,
    verify_step_invariants,
};
use crate::model::{DstSummary, MutationKind, SoundnessFailure, WorkspaceShape};
use crate::mutations::{
    apply_mutation, corrupt_cache_dir, git_commit_all, git_init_and_commit, git_reset_clean,
};
use crate::node_oracle::{DST_RUNNER_JS, NodeOracleWorker};
use crate::rng::SeededRng;
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

pub fn run_dst_sweep(config: &DstConfig) -> Result<DstSummary, String> {
    let started = Instant::now();
    let workers = config.jobs.max(1).min(config.scenarios.max(1));
    let next_index = AtomicUsize::new(0);

    let worker_results: Vec<Result<WorkerAccumulator, String>> = thread::scope(|scope| {
        let mut handles = Vec::with_capacity(workers);
        for _ in 0..workers {
            handles.push(scope.spawn(|| run_worker(config, &next_index)));
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

fn run_worker(config: &DstConfig, next_index: &AtomicUsize) -> Result<WorkerAccumulator, String> {
    let mut oracle = NodeOracleWorker::spawn(&config.node_bin)?;
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
        if let Err(error) = run_one_scenario(config, index, seed, node_dir, &mut oracle, &mut acc) {
            acc.harness_errors += 1;
            if acc.sample_failures.len() < config.max_sample_failures {
                acc.sample_failures.push(SoundnessFailure {
                    seed,
                    step: 0,
                    mutation: config
                        .filter_mutation
                        .unwrap_or(MutationKind::PureExportValue),
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

struct ScenarioPaths {
    workspace_dir: PathBuf,
    shared_cache_dir: PathBuf,
    runner_script: PathBuf,
}

struct DadStepSpec<'a> {
    dad_bin: &'a Path,
    paths: &'a ScenarioPaths,
    baseline_sha: &'a str,
    head_sha: Option<&'a str>,
    use_plan_file: bool,
    use_cache: bool,
    step_tag: usize,
    node_dir: Option<&'a Path>,
}

fn run_one_scenario(
    config: &DstConfig,
    scenario_index: usize,
    seed: u64,
    node_dir: Option<&Path>,
    oracle: &mut NodeOracleWorker,
    acc: &mut WorkerAccumulator,
) -> Result<(), String> {
    let mut rng = SeededRng::new(seed);
    let shape = pick_workspace_shape(seed, &mut rng);
    let temp_root = create_scenario_dir(seed, scenario_index)?;
    let paths = ScenarioPaths {
        workspace_dir: temp_root.join("ws"),
        shared_cache_dir: temp_root.join("shared-cache"),
        runner_script: temp_root.join("dst-runner.mjs"),
    };
    fs::create_dir_all(&paths.workspace_dir).map_err(|e| format!("mkdir ws: {e}"))?;
    fs::create_dir_all(&paths.shared_cache_dir).map_err(|e| format!("mkdir cache: {e}"))?;
    fs::write(&paths.runner_script, DST_RUNNER_JS).map_err(|e| format!("write dst-runner: {e}"))?;

    let result = execute_scenario_timeline(
        &TimelineInput {
            config,
            scenario_index,
            paths: &paths,
            shape: &shape,
            node_dir,
        },
        &mut rng,
        oracle,
        acc,
    );

    let failed_in_scenario = result.as_ref().is_ok_and(|had_failure| *had_failure);
    if !failed_in_scenario || !config.keep_failed {
        let _ = fs::remove_dir_all(&temp_root);
    }
    result.map(|_| ())
}

struct TimelineInput<'a> {
    config: &'a DstConfig,
    scenario_index: usize,
    paths: &'a ScenarioPaths,
    shape: &'a WorkspaceShape,
    node_dir: Option<&'a Path>,
}

fn execute_scenario_timeline(
    input: &TimelineInput<'_>,
    rng: &mut SeededRng,
    oracle: &mut NodeOracleWorker,
    acc: &mut WorkerAccumulator,
) -> Result<bool, String> {
    let generated = generate_workspace(
        &input.paths.workspace_dir,
        &input.paths.runner_script,
        &input.config.node_bin,
        input.shape,
        rng,
    )?;
    let baseline_sha = git_init_and_commit(&input.paths.workspace_dir, "dst baseline")?;

    let baseline_oracle = oracle.evaluate(&input.paths.workspace_dir, &generated.oracle_tests)?;
    for (file, outcome) in &baseline_oracle {
        if !outcome.ok {
            return Err(format!(
                "baseline oracle failed for {file}: {:?}",
                outcome.error
            ));
        }
    }

    warm_shared_cache(
        &input.config.dad_bin,
        &input.paths.workspace_dir,
        &input.paths.shared_cache_dir,
        input.node_dir,
    )?;

    let mut had_failure = false;
    let steps = input.config.steps_per_scenario.max(1);
    for step_idx in 0..steps {
        if step_idx > 0 {
            git_reset_clean(&input.paths.workspace_dir, &baseline_sha)?;
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
                baseline_sha: &baseline_sha,
                generated: &generated,
                mutation,
                step_idx,
                node_dir: input.node_dir,
            },
            oracle,
            acc,
        )?;
        had_failure |= step_failed;
    }
    acc.scenarios_run += 1;
    Ok(had_failure)
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
        let index = scenario_index % MutationKind::ALL.len();
        return MutationKind::ALL[index];
    }
    *rng.choose(MutationKind::ALL)
        .unwrap_or(&MutationKind::PureExportValue)
}

fn warm_shared_cache(
    dad_bin: &Path,
    workspace_dir: &Path,
    shared_cache_dir: &Path,
    node_dir: Option<&Path>,
) -> Result<(), String> {
    let mut request =
        NativeRequestPayload::new("run", workspace_dir.to_string_lossy().into_owned());
    request.only = true;
    request.task_ids = vec![
        "ui:test".to_owned(),
        "impact-consumer:test".to_owned(),
        "unrelated:test".to_owned(),
    ];
    request.cache = true;
    request.cache_dir = Some(shared_cache_dir.to_string_lossy().into_owned());
    let response = invoke_dad(dad_bin, &request, node_dir)?;
    if !response.envelope.ok || !response.exit_ok {
        return Err(format!(
            "baseline warm-cache run failed: {:?}",
            response.envelope.error
        ));
    }
    Ok(())
}

struct StepRunInput<'a> {
    config: &'a DstConfig,
    paths: &'a ScenarioPaths,
    baseline_sha: &'a str,
    generated: &'a GeneratedWorkspace,
    mutation: MutationKind,
    step_idx: usize,
    node_dir: Option<&'a Path>,
}

fn run_mutation_step(
    input: &StepRunInput<'_>,
    oracle: &mut NodeOracleWorker,
    acc: &mut WorkerAccumulator,
) -> Result<bool, String> {
    let workspace_dir = &input.paths.workspace_dir;
    let applied = apply_mutation(
        workspace_dir,
        &input.generated.shape,
        input.mutation,
        input.step_idx,
    )?;
    let commit_step = applied.force_commit || input.generated.shape.commit_before_plan;
    let head_sha = if commit_step {
        Some(git_commit_all(
            workspace_dir,
            &format!("dst step {} {}", input.step_idx, input.mutation.as_str()),
        )?)
    } else {
        None
    };
    if applied.corrupt_shared_cache {
        let _ = corrupt_cache_dir(&input.paths.shared_cache_dir)?;
    }

    let oracle_outcomes = oracle.evaluate(workspace_dir, &input.generated.oracle_tests)?;
    let use_plan_file = applied.force_plan_file || input.generated.shape.use_plan_file;
    let use_cache = input.generated.shape.use_shared_cache
        || applied.force_commit
        || applied.corrupt_shared_cache;
    let invocation = run_dad_step(&DadStepSpec {
        dad_bin: &input.config.dad_bin,
        paths: input.paths,
        baseline_sha: input.baseline_sha,
        head_sha: head_sha.as_deref(),
        use_plan_file,
        use_cache,
        step_tag: input.step_idx,
        node_dir: input.node_dir,
    })?;

    let check_ctx = StepCheckCtx {
        config: input.config,
        workspace_dir,
        generated: input.generated,
        mutation: input.mutation,
        step_idx: input.step_idx,
        oracle_outcomes: &oracle_outcomes,
    };
    let mut had_failure = verify_step_invariants(&check_ctx, &invocation, acc);

    let oracle_had_failure = oracle_outcomes.values().any(|o| !o.ok);
    if oracle_had_failure && !had_failure && use_cache {
        let repeat = run_dad_step(&DadStepSpec {
            dad_bin: &input.config.dad_bin,
            paths: input.paths,
            baseline_sha: input.baseline_sha,
            head_sha: head_sha.as_deref(),
            use_plan_file,
            use_cache: true,
            step_tag: input.step_idx + 1000,
            node_dir: input.node_dir,
        })?;
        had_failure |= verify_failed_not_cached(&check_ctx, &repeat, acc);
    }

    acc.steps_executed += 1;
    Ok(had_failure)
}

fn run_dad_step(spec: &DadStepSpec<'_>) -> Result<DadInvocation, String> {
    let workspace_root = spec.paths.workspace_dir.to_string_lossy().into_owned();
    let cache_dir = spec
        .use_cache
        .then(|| spec.paths.shared_cache_dir.to_string_lossy().into_owned());

    if spec.use_plan_file {
        let mut plan_req = NativeRequestPayload::new("plan", workspace_root.clone());
        plan_req.base = Some(spec.baseline_sha.to_owned());
        plan_req.head = spec.head_sha.map(str::to_owned);
        let planned = invoke_dad(spec.dad_bin, &plan_req, spec.node_dir)?;
        let Some(plan_json) = planned.raw_plan_json else {
            return Err(format!(
                "plan failed before --plan-file run: {:?}",
                planned.envelope.error
            ));
        };
        let plan_file_path = spec
            .paths
            .shared_cache_dir
            .join(format!("plan-{}.json", spec.step_tag));
        fs::write(&plan_file_path, plan_json).map_err(|e| format!("write plan file: {e}"))?;
        let mut run_req = NativeRequestPayload::new("run", workspace_root);
        run_req.cache = spec.use_cache;
        run_req.cache_dir = cache_dir;
        run_req.plan_file = Some(plan_file_path.to_string_lossy().into_owned());
        return invoke_dad(spec.dad_bin, &run_req, spec.node_dir);
    }

    let mut run_req = NativeRequestPayload::new("run", workspace_root);
    run_req.base = Some(spec.baseline_sha.to_owned());
    run_req.head = spec.head_sha.map(str::to_owned);
    run_req.cache = spec.use_cache;
    run_req.cache_dir = cache_dir;
    invoke_dad(spec.dad_bin, &run_req, spec.node_dir)
}

fn create_scenario_dir(seed: u64, index: usize) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(format!("dads-dst-{}-{index}-{seed}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).map_err(|e| format!("create scenario dir {}: {e}", dir.display()))?;
    Ok(dir)
}
