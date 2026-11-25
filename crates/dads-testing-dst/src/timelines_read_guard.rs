//! Phase 2 runtime read-guard DST timelines (#69 & #70):
//! - `#69` `undeclared-dynamic-fs-read-enforced`
//! - `#70` `audit-fix-remediates-dynamic-read`

use crate::dad_client::{
    DadInvocation, ExecutedTaskView, NativeRequestPayload, invoke_dad_with_env,
};
use crate::invariants_report::{
    WorkerAccumulator, record_cache_integrity_violation, record_soundness_miss,
};
use crate::mutations::{git_commit_all, replace_once};
use crate::timelines_subsystems::{SpecialTimelineCtx, make_failure};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const TASK_ID: &str = "adv-dyn-fs:test";
const TEST_FILE: &str = "adv-dyn-fs/dyn-fs.test.ts";
const SECRET_FIXTURE_REL: &str = "settings/dyn-secret.json";
const ENV_PAIR: [(&str, &str); 1] = [("DST_SECRET_FIXTURE", SECRET_FIXTURE_REL)];

pub fn run_read_guard_enforced_timeline(
    ctx: &SpecialTimelineCtx<'_>,
    acc: &mut WorkerAccumulator,
) -> Result<bool, String> {
    bump_step_and_oracle(ctx, acc);
    let cache_dir = fresh_cache_dir(ctx.temp_root, "rg-enforced", ctx.step_idx)?;
    let first = run_enforced(ctx, &cache_dir, None)?;
    let first_task = find_task(&first)?;

    let mut had_failure = false;
    if !is_enforced_violation(first_task) {
        had_failure = true;
        miss(
            ctx,
            "read-guard-not-enforced",
            format!("expected enforced failure, got {first_task:?}"),
            first_task.cached,
            acc,
        );
    }
    let repeat = run_enforced(ctx, &cache_dir, None)?;
    let repeat_task = find_task(&repeat)?;
    if repeat_task.cached || !is_enforced_violation(repeat_task) {
        had_failure = true;
        cache_err(
            ctx,
            "read-guard-violation-cached",
            format!("repeat enforced run poisoned cache: {repeat_task:?}"),
            acc,
        );
    }
    Ok(had_failure)
}

pub fn run_audit_fix_remediates_timeline(
    ctx: &SpecialTimelineCtx<'_>,
    acc: &mut WorkerAccumulator,
) -> Result<bool, String> {
    bump_step_and_oracle(ctx, acc);
    let cache_dir = fresh_cache_dir(ctx.temp_root, "rg-audit", ctx.step_idx)?;
    run_audit_fix_cli(ctx)?;
    if !manifest_has_impact_path(ctx.workspace_dir, TASK_ID, SECRET_FIXTURE_REL)? {
        let msg = format!("manifest missing {SECRET_FIXTURE_REL} in {TASK_ID} impact.paths");
        miss(ctx, "audit-fix-missing-impact-path", msg, false, acc);
        return Ok(true);
    }

    let post_audit_sha = git_commit_all(ctx.workspace_dir, "dst audit fix manifest")?;
    let warm = run_enforced(ctx, &cache_dir, None)?;
    let warm_task = find_task(&warm)?;
    let clean_pass = !warm_task.cached
        && warm_task.status != "failed"
        && warm_task.exit_code == Some(0)
        && warm_task.undeclared_reads.is_empty();
    if !clean_pass {
        let msg = format!("expected clean pass after audit --fix, got {warm_task:?}");
        miss(ctx, "audit-fix-post-run-failed", msg, false, acc);
        return Ok(true);
    }

    let mut had_failure = false;
    let cached_hit = run_enforced(ctx, &cache_dir, None)?;
    let cached_task = find_task(&cached_hit)?;
    if !cached_task.cached || cached_task.status == "failed" {
        had_failure = true;
        let msg = format!("expected cached pass on repeat enforced run, got {cached_task:?}");
        cache_err(ctx, "audit-fix-did-not-cache", msg, acc);
    }

    replace_once(
        ctx.workspace_dir,
        SECRET_FIXTURE_REL,
        "\"secret\":2",
        "\"secret\":9",
    )?;
    let busted = run_enforced(ctx, &cache_dir, Some(&post_audit_sha))?;
    had_failure |= verify_mutation_caught(ctx, &busted, acc);
    Ok(had_failure)
}

fn verify_mutation_caught(
    ctx: &SpecialTimelineCtx<'_>,
    inv: &DadInvocation,
    acc: &mut WorkerAccumulator,
) -> bool {
    let Some(res) = &inv.envelope.result else {
        acc.harness_errors += 1;
        return true;
    };
    let planned_run = res
        .plan
        .tasks
        .iter()
        .any(|t| t.id == TASK_ID && t.decision == "run");
    let exec = res
        .run
        .as_ref()
        .and_then(|r| r.tasks.iter().find(|t| t.id == TASK_ID));
    let failed_fresh = exec.is_some_and(|t| {
        !t.cached && (t.status == "failed" || t.exit_code.is_some_and(|c| c != 0))
    });
    if planned_run && failed_fresh {
        return false;
    }
    let stale = exec.is_some_and(|t| t.cached);
    let kind = if stale {
        "stale-cache-hit"
    } else {
        "audit-fix-mutation-missed"
    };
    miss(
        ctx,
        kind,
        format!("planned_run={planned_run} exec={exec:?}"),
        stale,
        acc,
    );
    true
}

fn run_enforced(
    ctx: &SpecialTimelineCtx<'_>,
    cache_dir: &Path,
    base_sha: Option<&str>,
) -> Result<DadInvocation, String> {
    let ws = ctx.workspace_dir.to_string_lossy().into_owned();
    let mut req = NativeRequestPayload::new("run", ws);
    match base_sha {
        Some(base) => req.base = Some(base.to_owned()),
        None => {
            req.only = true;
            req.task_ids = vec![TASK_ID.to_owned()];
        }
    }
    req.cache = true;
    req.cache_dir = Some(cache_dir.to_string_lossy().into_owned());
    req.enforce_declared_reads = true;
    invoke_dad_with_env(&ctx.config.dad_bin, &req, ctx.node_dir, &ENV_PAIR)
}

fn run_audit_fix_cli(ctx: &SpecialTimelineCtx<'_>) -> Result<(), String> {
    let cli_js = find_dad_test_cli_js()?;
    let dad_bin = ctx
        .config
        .dad_bin
        .canonicalize()
        .unwrap_or_else(|_| ctx.config.dad_bin.clone());
    let mut cmd = Command::new(&ctx.config.node_bin);
    cmd.arg(&cli_js)
        .args(["audit", "--fix", "--task", TASK_ID, "--json"])
        .current_dir(ctx.workspace_dir)
        .env("DADS_TEST_NATIVE_BINARY", &dad_bin)
        .env("DST_SECRET_FIXTURE", SECRET_FIXTURE_REL);
    if let Some(dir) = ctx.node_dir {
        let mut combined = dir.as_os_str().to_os_string();
        combined.push(":");
        combined.push(std::env::var_os("PATH").unwrap_or_default());
        cmd.env("PATH", combined);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("spawn audit --fix: {e}"))?;
    if !out.status.success() {
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "audit --fix exited {:?}: stdout={stdout} stderr={stderr}",
            out.status.code()
        ));
    }
    Ok(())
}

fn is_enforced_violation(t: &ExecutedTaskView) -> bool {
    let failed = t.status == "failed" || t.exit_code.is_some_and(|c| c != 0);
    let has_path = t
        .undeclared_reads
        .iter()
        .any(|r| r.path == SECRET_FIXTURE_REL);
    let has_banner = t
        .stderr
        .as_ref()
        .is_some_and(|s| s.text.contains("UNDECLARED WORKSPACE READS"));
    failed && !t.cached && has_path && has_banner
}

fn find_task(inv: &DadInvocation) -> Result<&ExecutedTaskView, String> {
    inv.envelope
        .result
        .as_ref()
        .and_then(|r| r.run.as_ref())
        .and_then(|run| run.tasks.iter().find(|t| t.id == TASK_ID))
        .ok_or_else(|| {
            format!(
                "missing {TASK_ID} (ok={} err={:?})",
                inv.envelope.ok, inv.envelope.error
            )
        })
}

fn manifest_has_impact_path(ws: &Path, task_id: &str, expected: &str) -> Result<bool, String> {
    let raw = fs::read_to_string(ws.join("dads.testing.json")).map_err(|e| e.to_string())?;
    let doc: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let tasks = doc.get("tasks").and_then(Value::as_array);
    let found = tasks
        .and_then(|arr| {
            arr.iter()
                .find(|e| e.get("id").and_then(Value::as_str) == Some(task_id))
        })
        .and_then(|e| e.pointer("/impact/paths"))
        .and_then(Value::as_array)
        .is_some_and(|paths| {
            paths
                .iter()
                .filter_map(Value::as_str)
                .any(|p| p == expected)
        });
    Ok(found)
}

fn find_dad_test_cli_js() -> Result<PathBuf, String> {
    let rel = "packages/testing/core/bin/dad-test.js";
    let mut bases: Vec<PathBuf> = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR"))];
    if let Ok(cwd) = std::env::current_dir() {
        bases.push(cwd);
    }
    for base in bases {
        let mut cursor = Some(base.as_path());
        while let Some(dir) = cursor {
            let cand = dir.join(rel);
            if cand.is_file() {
                return cand
                    .canonicalize()
                    .map_err(|e| format!("canonicalize {rel}: {e}"));
            }
            cursor = dir.parent();
        }
    }
    Err(format!("could not locate {rel}"))
}

fn fresh_cache_dir(root: &Path, prefix: &str, step_idx: usize) -> Result<PathBuf, String> {
    let dir = root.join(format!("{prefix}-cache-{step_idx}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    Ok(dir)
}

fn bump_step_and_oracle(ctx: &SpecialTimelineCtx<'_>, acc: &mut WorkerAccumulator) {
    let entry = acc
        .by_mutation
        .entry(ctx.mutation.as_str().to_owned())
        .or_default();
    entry.steps += 1;
    entry.oracle_failures += 1;
    acc.oracle_failures_total += 1;
}

fn miss(
    ctx: &SpecialTimelineCtx<'_>,
    kind: &str,
    detail: String,
    stale: bool,
    acc: &mut WorkerAccumulator,
) {
    record_soundness_miss(
        make_failure(ctx, kind, TASK_ID, TEST_FILE, detail),
        stale,
        acc,
    );
}

fn cache_err(
    ctx: &SpecialTimelineCtx<'_>,
    kind: &str,
    detail: String,
    acc: &mut WorkerAccumulator,
) {
    record_cache_integrity_violation(make_failure(ctx, kind, TASK_ID, TEST_FILE, detail), acc);
}
