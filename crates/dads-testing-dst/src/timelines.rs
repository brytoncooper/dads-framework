//! Stateful multi-step CI timelines: chained dirty-tree snapshot patching, multi-branch shared L2
//! cache switching, and sharded `--plan-file` union completeness verification.

use crate::dad_client::{
    DadInvocation, ExecutedTaskView, NativeEnvelope, NativeRequestPayload, NativeResult, PlanView,
    PlannedTaskView, RunView, TaskShardPayload, invoke_dad,
};
use crate::mutations::{git_checkout_new_branch, git_commit_all, replace_once};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

pub fn warm_shared_cache(
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
        "adv:test".to_owned(),
        "adv-dyn-fs:test".to_owned(),
        "adv-always:test".to_owned(),
        "adv-env:test".to_owned(),
        "impact-consumer:test".to_owned(),
        "build-consumer:test".to_owned(),
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

pub fn prepare_chained_dirty_sequence(
    dad_bin: &Path,
    workspace_dir: &Path,
    shared_cache_dir: &Path,
    baseline_sha: &str,
    node_dir: Option<&Path>,
) -> Result<(), String> {
    // Edit A: touch pure export in billing/pure.ts and run dad-test (creates snapshot).
    replace_once(
        workspace_dir,
        "billing/pure.ts",
        "export const unusedPureExport = 7;",
        "export const unusedPureExport = 77;",
    )?;
    run_plain_plan(dad_bin, workspace_dir, baseline_sha, node_dir)?;

    // Edit B: introduce breaking change in lang/hop-a.ts and run dad-test (incremental patch).
    replace_once(workspace_dir, "lang/hop-a.ts", "origVal = 2", "origVal = 9")?;
    run_plain_plan(dad_bin, workspace_dir, baseline_sha, node_dir)?;

    // Revert A back to baseline while keeping B broken, plus add & delete an extra file.
    replace_once(
        workspace_dir,
        "billing/pure.ts",
        "export const unusedPureExport = 77;",
        "export const unusedPureExport = 7;",
    )?;
    let transient = workspace_dir.join("lang/transient-check.ts");
    fs::write(&transient, "export const transientVal = 1;\n")
        .map_err(|e| format!("write transient: {e}"))?;
    run_plain_plan(dad_bin, workspace_dir, baseline_sha, node_dir)?;
    let _ = fs::remove_file(&transient);
    let _ = shared_cache_dir;
    Ok(())
}

pub fn prepare_multi_branch_shared_l2(
    dad_bin: &Path,
    workspace_dir: &Path,
    shared_cache_dir: &Path,
    baseline_sha: &str,
    step_idx: usize,
    node_dir: Option<&Path>,
) -> Result<String, String> {
    // Worker A: branch with a passing edit warms shared L2 cache.
    git_checkout_new_branch(workspace_dir, &format!("dst-pass-{step_idx}"), baseline_sha)?;
    replace_once(
        workspace_dir,
        "core/math.ts",
        "// core math module",
        "// branch A passing comment",
    )?;
    let pass_sha = git_commit_all(workspace_dir, "branch A passing")?;
    let mut warm_req =
        NativeRequestPayload::new("run", workspace_dir.to_string_lossy().into_owned());
    warm_req.only = true;
    warm_req.task_ids = vec![
        "ui:test".to_owned(),
        "adv:test".to_owned(),
        "impact-consumer:test".to_owned(),
    ];
    warm_req.cache = true;
    warm_req.cache_dir = Some(shared_cache_dir.to_string_lossy().into_owned());
    let _ = invoke_dad(dad_bin, &warm_req, node_dir)?;
    let _ = pass_sha;

    // Worker B: branch from baseline with a breaking upstream change using the SAME shared L2.
    git_checkout_new_branch(
        workspace_dir,
        &format!("dst-break-{step_idx}"),
        baseline_sha,
    )?;
    replace_once(
        workspace_dir,
        "core/math.ts",
        "n * baseScale()",
        "n * baseScale() + 6",
    )?;
    git_commit_all(workspace_dir, "branch B breaking")
}

pub struct ShardedRunSpec<'a> {
    pub dad_bin: &'a Path,
    pub workspace_dir: &'a Path,
    pub shared_cache_dir: &'a Path,
    pub baseline_sha: &'a str,
    pub head_sha: Option<&'a str>,
    pub use_cache: bool,
    pub step_tag: usize,
    pub node_dir: Option<&'a Path>,
}

pub fn run_dad_single_step(
    spec: &ShardedRunSpec<'_>,
    use_plan_file: bool,
) -> Result<DadInvocation, String> {
    let workspace_root = spec.workspace_dir.to_string_lossy().into_owned();
    let cache_dir = spec
        .use_cache
        .then(|| spec.shared_cache_dir.to_string_lossy().into_owned());
    if use_plan_file {
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

pub fn run_dad_only_tasks_cached(
    spec: &ShardedRunSpec<'_>,
    task_ids: &[String],
) -> Result<DadInvocation, String> {
    let mut run_req =
        NativeRequestPayload::new("run", spec.workspace_dir.to_string_lossy().into_owned());
    run_req.only = true;
    run_req.task_ids = task_ids.to_vec();
    run_req.cache = true;
    run_req.cache_dir = Some(spec.shared_cache_dir.to_string_lossy().into_owned());
    invoke_dad(spec.dad_bin, &run_req, spec.node_dir)
}

pub fn run_sharded_plan_union(spec: &ShardedRunSpec<'_>) -> Result<DadInvocation, String> {
    let workspace_root = spec.workspace_dir.to_string_lossy().into_owned();
    let mut plan_req = NativeRequestPayload::new("plan", workspace_root.clone());
    plan_req.base = Some(spec.baseline_sha.to_owned());
    plan_req.head = spec.head_sha.map(str::to_owned);
    let planned = invoke_dad(spec.dad_bin, &plan_req, spec.node_dir)?;
    let Some(plan_json) = planned.raw_plan_json else {
        return Err(format!("sharded plan failed: {:?}", planned.envelope.error));
    };
    let plan_file_path = spec
        .shared_cache_dir
        .join(format!("plan-sharded-{}.json", spec.step_tag));
    fs::write(&plan_file_path, plan_json).map_err(|e| format!("write sharded plan: {e}"))?;

    let mut merged_plan: BTreeMap<String, PlannedTaskView> = BTreeMap::new();
    let mut merged_run: BTreeMap<String, ExecutedTaskView> = BTreeMap::new();
    let mut all_ok = true;
    let total_shards = 2u32;

    for shard_index in 1..=total_shards {
        let mut run_req = NativeRequestPayload::new("run", workspace_root.clone());
        run_req.cache = spec.use_cache;
        run_req.cache_dir = spec
            .use_cache
            .then(|| spec.shared_cache_dir.to_string_lossy().into_owned());
        run_req.plan_file = Some(plan_file_path.to_string_lossy().into_owned());
        run_req.shard = Some(TaskShardPayload {
            index: shard_index,
            total: total_shards,
        });
        let shard_res = invoke_dad(spec.dad_bin, &run_req, spec.node_dir)?;
        all_ok &= shard_res.exit_ok;
        let Some(result) = shard_res.envelope.result else {
            return Err(format!(
                "shard {shard_index}/{total_shards} failed: {:?}",
                shard_res.envelope.error
            ));
        };
        for task in result.plan.tasks {
            let replace = merged_plan
                .get(&task.id)
                .is_none_or(|prev| prev.decision != "run" && task.decision == "run");
            if replace {
                merged_plan.insert(task.id.clone(), task);
            }
        }
        if let Some(run) = result.run {
            for executed in run.tasks {
                let replace = merged_run
                    .get(&executed.id)
                    .is_none_or(|prev| prev.status == "skipped" && executed.status != "skipped");
                if replace {
                    merged_run.insert(executed.id.clone(), executed);
                }
            }
        }
    }

    Ok(DadInvocation {
        raw_plan_json: None,
        envelope: NativeEnvelope {
            ok: all_ok,
            error: None,
            result: Some(NativeResult {
                plan: PlanView {
                    tasks: merged_plan.into_values().collect(),
                    issues: Vec::new(),
                },
                run: Some(RunView {
                    tasks: merged_run.into_values().collect(),
                }),
            }),
        },
        exit_ok: all_ok,
    })
}

fn run_plain_plan(
    dad_bin: &Path,
    workspace_dir: &Path,
    baseline_sha: &str,
    node_dir: Option<&Path>,
) -> Result<(), String> {
    let mut req = NativeRequestPayload::new("plan", workspace_dir.to_string_lossy().into_owned());
    req.base = Some(baseline_sha.to_owned());
    let res = invoke_dad(dad_bin, &req, node_dir)?;
    if !res.envelope.ok {
        return Err(format!(
            "chained dirty plan failed: {:?}",
            res.envelope.error
        ));
    }
    Ok(())
}
