//! Specialized Section B timeline #78: `remote-http-cache-fault-injection` exercising
//! `HttpCacheMock` across PUT/cold-L1 GET hit, 401 auth rejection, corrupt body, truncated
//! chunked body, HTTP 500, and stale-key receipt rejection.

use crate::dad_client::{NativeRequestPayload, invoke_dad_with_env};
use crate::http_cache_mock::{HttpCacheMock, HttpFaultMode};
use crate::invariants_report::{
    WorkerAccumulator, record_cache_integrity_violation, record_soundness_miss,
};
use crate::mutations::replace_once;
use crate::timelines_subsystems::{SpecialTimelineCtx, make_failure};
use std::fs;
use std::path::Path;

pub fn run_remote_cache_fault_timeline(
    ctx: &SpecialTimelineCtx<'_>,
    acc: &mut WorkerAccumulator,
) -> Result<bool, String> {
    acc.by_mutation
        .entry(ctx.mutation.as_str().to_owned())
        .or_default()
        .steps += 1;
    let token = "dst-secret-token";
    let mock = HttpCacheMock::start(Some(token.to_owned()))?;
    let remote_url = mock.base_url();
    let ws_root = ctx.workspace_dir.to_string_lossy().into_owned();
    let mut had_miss =
        verify_remote_healthy_roundtrip(ctx, &mock, &ws_root, &remote_url, token, acc)?;
    had_miss |= verify_remote_fault_injection(ctx, &mock, &ws_root, &remote_url, token, acc)?;
    Ok(had_miss)
}

fn verify_remote_healthy_roundtrip(
    ctx: &SpecialTimelineCtx<'_>,
    mock: &HttpCacheMock,
    ws_root: &str,
    remote_url: &str,
    token: &str,
    acc: &mut WorkerAccumulator,
) -> Result<bool, String> {
    let l1_warm = ctx.temp_root.join(format!("l1-warm-{}", ctx.step_idx));
    let l1_hit = ctx.temp_root.join(format!("l1-hit-{}", ctx.step_idx));
    let l1_auth = ctx.temp_root.join(format!("l1-auth-{}", ctx.step_idx));
    for dir in [&l1_warm, &l1_hit, &l1_auth] {
        fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    }
    let mut had_miss = false;
    let warm = run_remote_only_task(ctx, ws_root, &l1_warm, remote_url, token)?;
    if !warm.0 || warm.1 || mock.stats().puts == 0 {
        had_miss = true;
        record_cache_integrity_violation(
            make_failure(
                ctx,
                "remote-cache-put-failed",
                "unrelated:test",
                "unrelated/control.test.ts",
                format!(
                    "warm passed={} cached={} puts={}",
                    warm.0,
                    warm.1,
                    mock.stats().puts
                ),
            ),
            acc,
        );
    }
    let hit = run_remote_only_task(ctx, ws_root, &l1_hit, remote_url, token)?;
    if !hit.0 || !hit.1 || mock.stats().hits == 0 {
        had_miss = true;
        record_cache_integrity_violation(
            make_failure(
                ctx,
                "remote-cache-hit-failed",
                "unrelated:test",
                "unrelated/control.test.ts",
                format!(
                    "cold-L1 hit passed={} cached={} hits={}",
                    hit.0,
                    hit.1,
                    mock.stats().hits
                ),
            ),
            acc,
        );
    }
    let bad_auth = run_remote_only_task(ctx, ws_root, &l1_auth, remote_url, "wrong-token")?;
    if !bad_auth.0 || bad_auth.1 {
        had_miss = true;
        record_cache_integrity_violation(
            make_failure(
                ctx,
                "remote-cache-auth-violation",
                "unrelated:test",
                "unrelated/control.test.ts",
                format!(
                    "401 auth should fail closed: passed={} cached={}",
                    bad_auth.0, bad_auth.1
                ),
            ),
            acc,
        );
    }
    Ok(had_miss)
}

fn verify_remote_fault_injection(
    ctx: &SpecialTimelineCtx<'_>,
    mock: &HttpCacheMock,
    ws_root: &str,
    remote_url: &str,
    token: &str,
    acc: &mut WorkerAccumulator,
) -> Result<bool, String> {
    let l1_fault = ctx.temp_root.join(format!("l1-fault-{}", ctx.step_idx));
    fs::create_dir_all(&l1_fault).map_err(|e| format!("mkdir l1-fault: {e}"))?;
    replace_once(
        ctx.workspace_dir,
        "core/math.ts",
        "n * baseScale()",
        "n * baseScale() + 11",
    )?;
    let variant = (ctx.shape.seed as usize).wrapping_add(ctx.step_idx) % 4;
    let fault_mode = match variant {
        0 => HttpFaultMode::CorruptBodyOnGet,
        1 => HttpFaultMode::TruncatedBodyOnGet,
        2 => HttpFaultMode::Return500,
        _ => HttpFaultMode::StaleReceiptPayload,
    };
    mock.set_mode(fault_mode);
    acc.by_mutation
        .entry(ctx.mutation.as_str().to_owned())
        .or_default()
        .oracle_failures += 1;
    acc.oracle_failures_total += 1;

    let mut req = NativeRequestPayload::new("run", ws_root.to_owned());
    req.base = Some(ctx.baseline_sha.to_owned());
    req.cache = true;
    req.cache_dir = Some(l1_fault.to_string_lossy().into_owned());
    req.remote_cache_url = Some(remote_url.to_owned());
    let resp = invoke_dad_with_env(
        &ctx.config.dad_bin,
        &req,
        ctx.node_dir,
        &[("DADS_TESTING_REMOTE_CACHE_TOKEN", token)],
    )?;
    let ui_exec = resp
        .envelope
        .result
        .as_ref()
        .and_then(|r| r.run.as_ref())
        .and_then(|run| run.tasks.iter().find(|t| t.id == "ui:test"));
    let caught = ui_exec.is_some_and(|t| {
        !t.cached && (t.status == "failed" || t.exit_code.is_some_and(|c| c != 0))
    });
    if !caught {
        let is_stale = ui_exec.is_some_and(|t| t.cached);
        record_soundness_miss(
            make_failure(
                ctx,
                if is_stale {
                    "stale-cache-hit"
                } else {
                    "remote-fault-miss"
                },
                "ui:test",
                "ui/tax.test.ts",
                format!("fault={fault_mode:?} ui_exec={ui_exec:?}"),
            ),
            is_stale,
            acc,
        );
        return Ok(true);
    }
    Ok(false)
}

fn run_remote_only_task(
    ctx: &SpecialTimelineCtx<'_>,
    ws_root: &str,
    l1_dir: &Path,
    remote_url: &str,
    token: &str,
) -> Result<(bool, bool), String> {
    let mut req = NativeRequestPayload::new("run", ws_root.to_owned());
    req.only = true;
    req.task_ids = vec!["unrelated:test".to_owned()];
    req.cache = true;
    req.cache_dir = Some(l1_dir.to_string_lossy().into_owned());
    req.remote_cache_url = Some(remote_url.to_owned());
    let resp = invoke_dad_with_env(
        &ctx.config.dad_bin,
        &req,
        ctx.node_dir,
        &[("DADS_TESTING_REMOTE_CACHE_TOKEN", token)],
    )?;
    let task = resp
        .envelope
        .result
        .as_ref()
        .and_then(|r| r.run.as_ref())
        .and_then(|run| run.tasks.iter().find(|t| t.id == "unrelated:test"));
    let passed = resp.envelope.ok
        && task.is_some_and(|t| t.status != "failed" && (t.cached || t.exit_code == Some(0)));
    let cached = task.is_some_and(|t| t.cached);
    Ok((passed, cached))
}
