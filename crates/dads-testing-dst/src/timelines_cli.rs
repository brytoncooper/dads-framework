//! Specialized Section D timeline #95: CLI filters (`--projects`, `--exclude-projects`,
//! `--task-kinds`, `--targets`, `--all`), unequal `--weights` shards, and stale `--plan-file`
//! detection after working-tree edits.

use crate::dad_client::{DadInvocation, NativeRequestPayload, TaskShardPayload, invoke_dad};
use crate::invariants_report::{WorkerAccumulator, record_soundness_miss};
use crate::mutations::replace_once;
use crate::timelines_subsystems::{SpecialTimelineCtx, make_failure as failure};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;

pub fn run_cli_filters_shard_stale_plan_timeline(
    ctx: &SpecialTimelineCtx<'_>,
    acc: &mut WorkerAccumulator,
) -> Result<bool, String> {
    acc.by_mutation
        .entry(ctx.mutation.as_str().to_owned())
        .or_default()
        .steps += 1;
    let variant = (ctx.shape.seed as usize).wrapping_add(ctx.step_idx) % 3;
    match variant {
        0 => verify_cli_filters(ctx, acc),
        1 => verify_weighted_shards(ctx, acc),
        _ => verify_stale_plan_file(ctx, acc),
    }
}

fn verify_cli_filters(
    ctx: &SpecialTimelineCtx<'_>,
    acc: &mut WorkerAccumulator,
) -> Result<bool, String> {
    replace_once(
        ctx.workspace_dir,
        "core/math.ts",
        "n * baseScale()",
        "n * baseScale() + 12",
    )?;
    replace_once(
        ctx.workspace_dir,
        "lang/hop-a.ts",
        "origVal = 2",
        "origVal = 9",
    )?;
    replace_once(
        ctx.workspace_dir,
        "types-lib/contracts.ts",
        "export type Currency = \"USD\" | \"EUR\";",
        "export type Currency = \"EUR\";",
    )?;
    bump_oracle_failure(ctx, acc);

    let ws_root = ctx.workspace_dir.to_string_lossy().into_owned();
    let mut had_miss = check_project_and_exclude_filters(ctx, &ws_root, acc)?;
    had_miss |= check_kind_target_and_all_filters(ctx, &ws_root, acc)?;
    Ok(had_miss)
}

fn check_project_and_exclude_filters(
    ctx: &SpecialTimelineCtx<'_>,
    ws_root: &str,
    acc: &mut WorkerAccumulator,
) -> Result<bool, String> {
    let mut had_miss = false;
    let mut proj_req = NativeRequestPayload::new("run", ws_root.to_owned());
    proj_req.base = Some(ctx.baseline_sha.to_owned());
    proj_req.projects = vec!["ui".to_owned()];
    let proj_resp = invoke_dad(&ctx.config.dad_bin, &proj_req, ctx.node_dir)?;
    if !check_filtered_run(&proj_resp, "ui:test", Some("adv:test")) {
        had_miss = true;
        record_soundness_miss(
            failure(
                ctx,
                "cli-projects-filter-bug",
                "ui:test",
                "ui/tax.test.ts",
                "--projects ui did not run and fail ui:test exclusively".to_owned(),
            ),
            false,
            acc,
        );
    }

    let mut excl_req = NativeRequestPayload::new("run", ws_root.to_owned());
    excl_req.base = Some(ctx.baseline_sha.to_owned());
    excl_req.exclude_projects = vec!["ui".to_owned()];
    let excl_resp = invoke_dad(&ctx.config.dad_bin, &excl_req, ctx.node_dir)?;
    if !check_filtered_run(&excl_resp, "adv:test", Some("ui:test")) {
        had_miss = true;
        record_soundness_miss(
            failure(
                ctx,
                "cli-exclude-projects-bug",
                "adv:test",
                "adv/multi-hop.test.ts",
                "--exclude-projects ui failed".to_owned(),
            ),
            false,
            acc,
        );
    }
    Ok(had_miss)
}

fn check_kind_target_and_all_filters(
    ctx: &SpecialTimelineCtx<'_>,
    ws_root: &str,
    acc: &mut WorkerAccumulator,
) -> Result<bool, String> {
    let mut had_miss = false;
    let mut kind_req = NativeRequestPayload::new("run", ws_root.to_owned());
    kind_req.base = Some(ctx.baseline_sha.to_owned());
    kind_req.task_kinds = vec!["typecheck".to_owned()];
    let kind_resp = invoke_dad(&ctx.config.dad_bin, &kind_req, ctx.node_dir)?;
    if !check_filtered_run(&kind_resp, "typecheck-app:typecheck", Some("ui:test")) {
        had_miss = true;
        record_soundness_miss(
            failure(
                ctx,
                "cli-task-kinds-bug",
                "typecheck-app:typecheck",
                "typecheck-app/tsconfig.json",
                "--task-kinds typecheck failed".to_owned(),
            ),
            false,
            acc,
        );
    }

    let mut tgt_req = NativeRequestPayload::new("run", ws_root.to_owned());
    tgt_req.base = Some(ctx.baseline_sha.to_owned());
    tgt_req.targets = vec!["typecheck".to_owned()];
    let tgt_resp = invoke_dad(&ctx.config.dad_bin, &tgt_req, ctx.node_dir)?;
    if !check_filtered_run(&tgt_resp, "typecheck-app:typecheck", Some("adv:test")) {
        had_miss = true;
        record_soundness_miss(
            failure(
                ctx,
                "cli-targets-bug",
                "typecheck-app:typecheck",
                "typecheck-app/tsconfig.json",
                "--targets typecheck failed".to_owned(),
            ),
            false,
            acc,
        );
    }

    let mut all_req = NativeRequestPayload::new("plan", ws_root.to_owned());
    all_req.all = true;
    let all_resp = invoke_dad(&ctx.config.dad_bin, &all_req, ctx.node_dir)?;
    let all_run = all_resp.envelope.result.as_ref().is_some_and(|r| {
        !r.plan.tasks.is_empty() && r.plan.tasks.iter().all(|t| t.decision == "run")
    });
    if !all_run {
        had_miss = true;
        record_soundness_miss(
            failure(
                ctx,
                "cli-all-flag-bug",
                "all",
                "",
                "--all did not select all tasks".to_owned(),
            ),
            false,
            acc,
        );
    }
    Ok(had_miss)
}

fn verify_weighted_shards(
    ctx: &SpecialTimelineCtx<'_>,
    acc: &mut WorkerAccumulator,
) -> Result<bool, String> {
    replace_once(
        ctx.workspace_dir,
        "core/math.ts",
        "n * baseScale()",
        "n * baseScale() + 12",
    )?;
    replace_once(
        ctx.workspace_dir,
        "lang/hop-a.ts",
        "origVal = 2",
        "origVal = 9",
    )?;
    replace_once(
        ctx.workspace_dir,
        "next-app/app/(auth)/[id]/[...slug]/@slot/data file.ts",
        "routeVal = 2",
        "routeVal = 9",
    )?;
    bump_oracle_failure(ctx, acc);

    let ws_root = ctx.workspace_dir.to_string_lossy().into_owned();
    let mut plan_req = NativeRequestPayload::new("plan", ws_root.clone());
    plan_req.all = true;
    let planned = invoke_dad(&ctx.config.dad_bin, &plan_req, ctx.node_dir)?;
    let Some(plan_json) = planned.raw_plan_json else {
        return Err("weighted shard baseline plan failed".to_owned());
    };
    let expected_tasks: BTreeSet<String> = planned
        .envelope
        .result
        .as_ref()
        .map(|r| r.plan.tasks.iter().map(|t| t.id.clone()).collect())
        .unwrap_or_default();
    let plan_file = ctx
        .temp_root
        .join(format!("weighted-plan-{}.json", ctx.step_idx));
    fs::write(&plan_file, plan_json).map_err(|e| format!("write weighted plan: {e}"))?;

    let mut weights = BTreeMap::new();
    weights.insert("ui".to_owned(), 100.0);
    weights.insert("adv".to_owned(), 10.0);
    weights.insert("next-app".to_owned(), 1.0);

    let mut seen_runnable = BTreeSet::new();
    let mut overlap = false;
    let mut weighted_flag_ok = true;
    let mut failed_ids = BTreeSet::new();
    for idx in 1..=3u32 {
        let mut req = NativeRequestPayload::new("run", ws_root.clone());
        req.plan_file = Some(plan_file.to_string_lossy().into_owned());
        req.shard = Some(TaskShardPayload {
            index: idx,
            total: 3,
        });
        req.shard_weights = weights.clone();
        let resp = invoke_dad(&ctx.config.dad_bin, &req, ctx.node_dir)?;
        let Some(res) = resp.envelope.result else {
            return Err(format!(
                "weighted shard {idx}/3 errored: {:?}",
                resp.envelope.error
            ));
        };
        weighted_flag_ok &= res.plan.shard.as_ref().is_some_and(|s| s.weighted);
        for t in &res.plan.tasks {
            if t.decision == "run" && !seen_runnable.insert(t.id.clone()) {
                overlap = true;
            }
        }
        if let Some(run) = res.run {
            for t in run.tasks {
                if t.status == "failed" || t.exit_code.is_some_and(|c| c != 0) {
                    failed_ids.insert(t.id);
                }
            }
        }
    }

    let required = ["ui:test", "adv:test", "next-app:test"];
    let all_caught = required.iter().all(|id| failed_ids.contains(*id));
    if !weighted_flag_ok || overlap || seen_runnable != expected_tasks || !all_caught {
        record_soundness_miss(
            failure(
                ctx,
                "weighted-shard-violation",
                "shard-union",
                "",
                format!(
                    "weighted={weighted_flag_ok} overlap={overlap} covered={}/{} failed={failed_ids:?}",
                    seen_runnable.len(),
                    expected_tasks.len()
                ),
            ),
            false,
            acc,
        );
        return Ok(true);
    }
    Ok(false)
}

fn verify_stale_plan_file(
    ctx: &SpecialTimelineCtx<'_>,
    acc: &mut WorkerAccumulator,
) -> Result<bool, String> {
    replace_once(
        ctx.workspace_dir,
        "unrelated/control.test.ts",
        "1 + 1 !== 2",
        "2 + 2 !== 4",
    )?;
    let ws_root = ctx.workspace_dir.to_string_lossy().into_owned();
    let mut plan_req = NativeRequestPayload::new("plan", ws_root.clone());
    plan_req.base = Some(ctx.baseline_sha.to_owned());
    let planned = invoke_dad(&ctx.config.dad_bin, &plan_req, ctx.node_dir)?;
    let Some(plan_json) = planned.raw_plan_json else {
        return Err("stale-plan baseline plan failed".to_owned());
    };
    let plan_file = ctx
        .temp_root
        .join(format!("stale-plan-{}.json", ctx.step_idx));
    fs::write(&plan_file, plan_json).map_err(|e| format!("write stale plan: {e}"))?;

    replace_once(
        ctx.workspace_dir,
        "core/math.ts",
        "n * baseScale()",
        "n * baseScale() + 15",
    )?;
    bump_oracle_failure(ctx, acc);

    let mut run_req = NativeRequestPayload::new("run", ws_root);
    run_req.plan_file = Some(plan_file.to_string_lossy().into_owned());
    run_req.cache = true;
    run_req.cache_dir = Some(ctx.shared_cache_dir.to_string_lossy().into_owned());
    let resp = invoke_dad(&ctx.config.dad_bin, &run_req, ctx.node_dir)?;

    let rejected_stale = !resp.envelope.ok || !resp.exit_ok;
    let ui_failed = resp
        .envelope
        .result
        .as_ref()
        .and_then(|r| r.run.as_ref())
        .and_then(|run| run.tasks.iter().find(|t| t.id == "ui:test"))
        .is_some_and(|t| {
            !t.cached && (t.status == "failed" || t.exit_code.is_some_and(|c| c != 0))
        });
    if !rejected_stale && !ui_failed {
        record_soundness_miss(
            failure(
                ctx,
                "stale-plan-file-missed-failure",
                "ui:test",
                "ui/tax.test.ts",
                "dad-test run --plan-file silently succeeded despite working-tree edit breaking ui:test after plan generation".to_owned(),
            ),
            false,
            acc,
        );
        return Ok(true);
    }
    Ok(false)
}

fn check_filtered_run(
    resp: &DadInvocation,
    must_fail_task: &str,
    must_exclude_task: Option<&str>,
) -> bool {
    let Some(res) = &resp.envelope.result else {
        return false;
    };
    if let Some(excluded) = must_exclude_task
        && res.plan.tasks.iter().any(|t| t.id == excluded)
    {
        return false;
    }
    res.run
        .as_ref()
        .and_then(|r| r.tasks.iter().find(|t| t.id == must_fail_task))
        .is_some_and(|t| t.status == "failed" || t.exit_code.is_some_and(|c| c != 0))
}

fn bump_oracle_failure(ctx: &SpecialTimelineCtx<'_>, acc: &mut WorkerAccumulator) {
    acc.by_mutation
        .entry(ctx.mutation.as_str().to_owned())
        .or_default()
        .oracle_failures += 1;
    acc.oracle_failures_total += 1;
}
