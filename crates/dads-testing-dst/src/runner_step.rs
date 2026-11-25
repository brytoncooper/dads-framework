//! Single-step DST execution: dispatches standard mutations, special subsystem/lifecycle
//! timelines, Node 24 + `tsc` oracles, repeat cache-integrity checks, and worktree cleanup.

use crate::generator::GeneratedWorkspace;
use crate::invariants::{
    StepCheckCtx, WorkerAccumulator, verify_failed_not_cached, verify_step_invariants,
    verify_unrelated_batch_isolation,
};
use crate::model::MutationKind;
use crate::mutations::{
    AppliedMutation, SpecialTimeline, apply_mutation, corrupt_cache_dir, git_commit_all,
    run_build_dep_script, run_git,
};
use crate::mutations_advanced::AdvancedMutationPaths;
use crate::node_oracle::{NodeOracleWorker, OracleTestOutcome, oracle_specs_with_override};
use crate::runner::{DstConfig, ScenarioPaths};
use crate::timelines::{
    ShardedRunSpec, prepare_chained_dirty_sequence, prepare_multi_branch_shared_l2,
    run_dad_only_tasks_cached, run_dad_single_step, run_sharded_plan_union,
};
use crate::timelines_cli::run_cli_filters_shard_stale_plan_timeline;
use crate::timelines_concurrency::run_concurrent_cache_writers_timeline;
use crate::timelines_read_guard::{
    run_audit_fix_remediates_timeline, run_read_guard_enforced_timeline,
};
use crate::timelines_remote_cache::run_remote_cache_fault_timeline;
use crate::timelines_subsystems::{SpecialTimelineCtx, run_boundaries_timeline};
use crate::tsc_oracle::{TscOracleOutcome, TscOracleWorker};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

pub(crate) struct StepRunInput<'a> {
    pub(crate) config: &'a DstConfig,
    pub(crate) paths: &'a ScenarioPaths,
    pub(crate) baseline_sha: &'a str,
    pub(crate) generated: &'a GeneratedWorkspace,
    pub(crate) mutation: MutationKind,
    pub(crate) step_idx: usize,
    pub(crate) node_dir: Option<&'a Path>,
}

pub(crate) fn run_mutation_step(
    input: &StepRunInput<'_>,
    oracle: &mut NodeOracleWorker,
    tsc_oracle: &mut TscOracleWorker,
    acc: &mut WorkerAccumulator,
) -> Result<bool, String> {
    let workspace_dir = &input.paths.workspace_dir;
    let adv_paths = AdvancedMutationPaths {
        workspace_dir,
        temp_root: &input.paths.temp_root,
        external_flag_path: &input.paths.external_flag_path,
        symlink_target_path: &input.paths.symlink_target_path,
        baseline_sha: input.baseline_sha,
        node_bin: &input.config.node_bin,
    };
    let applied = apply_mutation(
        &adv_paths,
        &input.generated.shape,
        input.mutation,
        input.step_idx,
    )?;

    if let Some(special) = applied.special_timeline {
        let had_failure = dispatch_special_timeline(input, special, acc)?;
        acc.steps_executed += 1;
        return Ok(had_failure);
    }

    let step_result = execute_standard_step(input, &applied, oracle, tsc_oracle, acc);
    if let Some(wt_dir) = &applied.worktree_override_dir {
        let wt_str = wt_dir.to_string_lossy().into_owned();
        let _ = run_git(workspace_dir, &["worktree", "remove", "--force", &wt_str]);
        let _ = fs::remove_dir_all(wt_dir);
    }
    let had_failure = step_result?;
    acc.steps_executed += 1;
    Ok(had_failure)
}

fn dispatch_special_timeline(
    input: &StepRunInput<'_>,
    special: SpecialTimeline,
    acc: &mut WorkerAccumulator,
) -> Result<bool, String> {
    let ctx = SpecialTimelineCtx {
        config: input.config,
        workspace_dir: &input.paths.workspace_dir,
        temp_root: &input.paths.temp_root,
        shared_cache_dir: &input.paths.shared_cache_dir,
        baseline_sha: input.baseline_sha,
        shape: &input.generated.shape,
        mutation: input.mutation,
        step_idx: input.step_idx,
        node_dir: input.node_dir,
    };
    match special {
        SpecialTimeline::BoundariesCheck => run_boundaries_timeline(&ctx, acc),
        SpecialTimeline::RemoteCacheFault => run_remote_cache_fault_timeline(&ctx, acc),
        SpecialTimeline::ConcurrentCacheWriters => run_concurrent_cache_writers_timeline(&ctx, acc),
        SpecialTimeline::CliFiltersShardStalePlan => {
            run_cli_filters_shard_stale_plan_timeline(&ctx, acc)
        }
        SpecialTimeline::ReadGuardEnforced => run_read_guard_enforced_timeline(&ctx, acc),
        SpecialTimeline::AuditFixRemediates => run_audit_fix_remediates_timeline(&ctx, acc),
    }
}

struct StepOracleResults {
    node: BTreeMap<String, OracleTestOutcome>,
    tsc: BTreeMap<String, TscOracleOutcome>,
    extra_task_tests: Vec<(String, String)>,
}

fn evaluate_step_oracles(
    input: &StepRunInput<'_>,
    applied: &AppliedMutation,
    effective_ws: &Path,
    oracle: &mut NodeOracleWorker,
    tsc_oracle: &mut TscOracleWorker,
) -> Result<StepOracleResults, String> {
    let deleted: BTreeSet<&str> = applied
        .deleted_test_files
        .iter()
        .map(String::as_str)
        .collect();
    let mut oracle_specs: Vec<_> = oracle_specs_with_override(
        &input.generated.oracle_tests,
        applied.oracle_env_override.as_ref(),
    )
    .into_iter()
    .filter(|spec| !deleted.contains(spec.file.as_str()))
    .collect();
    let extra_task_tests: Vec<(String, String)> = applied
        .extra_oracle_tests
        .iter()
        .map(|(task_id, spec)| {
            oracle_specs.push(spec.clone());
            (task_id.clone(), spec.file.clone())
        })
        .collect();

    if applied.rebuild_dep_for_oracle {
        run_build_dep_script(&input.config.node_bin, effective_ws)?;
    }
    let node = oracle.evaluate(effective_ws, &oracle_specs)?;
    if applied.rebuild_dep_for_oracle {
        fs::write(
            effective_ws.join("build-dep/dist/out.json"),
            "{\"val\":2}\n",
        )
        .map_err(|e| format!("reset out.json: {e}"))?;
    }

    let mut tsc = BTreeMap::new();
    if input.mutation.uses_tsc_oracle() {
        for (task_id, tsconfig_rel) in &input.generated.typecheck_tasks {
            let outcome = tsc_oracle.check(effective_ws, tsconfig_rel)?;
            tsc.insert(task_id.clone(), outcome);
        }
    }
    Ok(StepOracleResults {
        node,
        tsc,
        extra_task_tests,
    })
}

fn execute_standard_step(
    input: &StepRunInput<'_>,
    applied: &AppliedMutation,
    oracle: &mut NodeOracleWorker,
    tsc_oracle: &mut TscOracleWorker,
    acc: &mut WorkerAccumulator,
) -> Result<bool, String> {
    let effective_ws = applied
        .worktree_override_dir
        .as_deref()
        .unwrap_or(&input.paths.workspace_dir);
    let head_sha = prepare_step_head(input, applied)?;
    if applied.corrupt_shared_cache {
        let _ = corrupt_cache_dir(&input.paths.shared_cache_dir)?;
    }
    let oracles = evaluate_step_oracles(input, applied, effective_ws, oracle, tsc_oracle)?;

    let use_plan_file = applied.force_plan_file || input.generated.shape.use_plan_file;
    let use_cache = should_use_cache(input, applied);
    let step_spec = ShardedRunSpec {
        dad_bin: &input.config.dad_bin,
        workspace_dir: effective_ws,
        shared_cache_dir: &input.paths.shared_cache_dir,
        baseline_sha: input.baseline_sha,
        head_sha: head_sha.as_deref(),
        use_cache,
        step_tag: input.step_idx,
        node_dir: input.node_dir,
        extra_env: &applied.dad_process_env,
    };
    let invocation = if !applied.force_only_tasks.is_empty() {
        run_dad_only_tasks_cached(&step_spec, &applied.force_only_tasks)?
    } else if applied.sharded_plan_union {
        run_sharded_plan_union(&step_spec)?
    } else {
        run_dad_single_step(&step_spec, use_plan_file)?
    };

    let check_ctx = StepCheckCtx {
        config: input.config,
        workspace_dir: effective_ws,
        generated: input.generated,
        mutation: input.mutation,
        step_idx: input.step_idx,
        oracle_outcomes: &oracles.node,
        tsc_outcomes: &oracles.tsc,
        extra_task_tests: &oracles.extra_task_tests,
        deleted_test_files: &applied.deleted_test_files,
        expected_skipped_tasks: &applied.expected_skipped_tasks,
    };
    let mut had_failure = verify_step_invariants(&check_ctx, &invocation, acc);
    if applied.verify_unrelated_passes {
        had_failure |= verify_unrelated_batch_isolation(&check_ctx, &invocation, acc);
    }

    let oracle_had_failure =
        oracles.node.values().any(|o| !o.ok) || oracles.tsc.values().any(|o| !o.passed);
    if oracle_had_failure && !had_failure && use_cache && !applied.sharded_plan_union {
        let repeat_spec = ShardedRunSpec {
            use_cache: true,
            step_tag: input.step_idx + 1000,
            ..step_spec
        };
        let repeat = if !applied.force_only_tasks.is_empty() {
            run_dad_only_tasks_cached(&repeat_spec, &applied.force_only_tasks)?
        } else {
            run_dad_single_step(&repeat_spec, use_plan_file)?
        };
        had_failure |= verify_failed_not_cached(&check_ctx, &repeat, acc);
        if applied.verify_unrelated_passes {
            had_failure |= verify_unrelated_batch_isolation(&check_ctx, &repeat, acc);
        }
    }
    Ok(had_failure)
}

fn should_use_cache(input: &StepRunInput<'_>, applied: &AppliedMutation) -> bool {
    input.generated.shape.use_shared_cache
        || applied.force_commit
        || applied.corrupt_shared_cache
        || applied.multi_branch_l2_cache
        || !applied.force_only_tasks.is_empty()
        || matches!(
            input.mutation,
            MutationKind::AlwaysModeNeverCached
                | MutationKind::TypecheckTypeOnlyAndAmbientDts
                | MutationKind::ImportMetaGlobAddEditDelete
                | MutationKind::SqlMigrationImpactAndCache
                | MutationKind::EncodingCrlfBomBinaryChmod
                | MutationKind::SameSizeSameMsEditAndEnvDrift
        )
}

fn prepare_step_head(
    input: &StepRunInput<'_>,
    applied: &AppliedMutation,
) -> Result<Option<String>, String> {
    let workspace_dir = &input.paths.workspace_dir;
    if let Some(head) = &applied.git_head_override {
        Ok(Some(head.clone()))
    } else if applied.force_untracked {
        Ok(None)
    } else if applied.chained_dirty_steps {
        prepare_chained_dirty_sequence(
            &input.config.dad_bin,
            workspace_dir,
            &input.paths.shared_cache_dir,
            input.baseline_sha,
            input.node_dir,
        )?;
        Ok(None)
    } else if applied.multi_branch_l2_cache {
        Ok(Some(prepare_multi_branch_shared_l2(
            &input.config.dad_bin,
            workspace_dir,
            &input.paths.shared_cache_dir,
            input.baseline_sha,
            input.step_idx,
            input.node_dir,
        )?))
    } else if applied.force_commit || input.generated.shape.commit_before_plan {
        Ok(Some(git_commit_all(
            workspace_dir,
            &format!("dst step {} {}", input.step_idx, input.mutation.as_str()),
        )?))
    } else {
        Ok(None)
    }
}
