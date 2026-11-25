//! Specialized Section D timeline #93: 4 simultaneous `dad-test run --cache --cache-dir`
//! child processes racing on passing and failing receipt keys.

use crate::dad_client::{NativeRequestPayload, invoke_dad};
use crate::invariants_report::{
    FailureRecord, WorkerAccumulator, record_cache_integrity_violation, record_soundness_miss,
};
use crate::mutations::replace_once;
use crate::timelines_subsystems::SpecialTimelineCtx;
use std::fs;
use std::path::Path;
use std::sync::Barrier;
use std::thread;

pub fn run_concurrent_cache_writers_timeline(
    ctx: &SpecialTimelineCtx<'_>,
    acc: &mut WorkerAccumulator,
) -> Result<bool, String> {
    acc.by_mutation
        .entry(ctx.mutation.as_str().to_owned())
        .or_default()
        .steps += 1;
    let race_dir = ctx.temp_root.join(format!("race-cache-{}", ctx.step_idx));
    fs::create_dir_all(&race_dir).map_err(|e| format!("mkdir race-cache: {e}"))?;
    let ws_root = ctx.workspace_dir.to_string_lossy().into_owned();
    let cache_str = race_dir.to_string_lossy().into_owned();

    let mut had_miss = run_passing_race(ctx, &ws_root, &cache_str, &race_dir, acc)?;
    had_miss |= run_failing_race(ctx, &ws_root, &cache_str, acc)?;
    Ok(had_miss)
}

fn run_passing_race(
    ctx: &SpecialTimelineCtx<'_>,
    ws_root: &str,
    cache_str: &str,
    race_dir: &Path,
    acc: &mut WorkerAccumulator,
) -> Result<bool, String> {
    let barrier = Barrier::new(4);
    let results: Vec<Result<bool, String>> = thread::scope(|scope| {
        let mut handles = Vec::with_capacity(4);
        for _ in 0..4 {
            handles.push(scope.spawn(|| {
                let mut req = NativeRequestPayload::new("run", ws_root.to_owned());
                req.only = true;
                req.task_ids = vec![
                    "unrelated:test".to_owned(),
                    "lock-alpha:test".to_owned(),
                    "lock-beta:test".to_owned(),
                ];
                req.cache = true;
                req.cache_dir = Some(cache_str.to_owned());
                barrier.wait();
                let resp = invoke_dad(&ctx.config.dad_bin, &req, ctx.node_dir)?;
                Ok(resp.envelope.ok && resp.exit_ok)
            }));
        }
        handles
            .into_iter()
            .map(|h| h.join().map_err(|_| "race worker panicked".to_owned())?)
            .collect()
    });
    let mut had_miss = false;
    for (idx, res) in results.into_iter().enumerate() {
        if !res? {
            had_miss = true;
            record_cache_integrity_violation(
                failure(
                    ctx,
                    "concurrent-cache-write-error",
                    "unrelated:test",
                    "unrelated/control.test.ts",
                    format!("concurrent writer #{idx} failed during passing race"),
                ),
                acc,
            );
        }
    }
    if let Some(corrupt_detail) = inspect_receipts_integrity(race_dir)? {
        had_miss = true;
        record_cache_integrity_violation(
            failure(
                ctx,
                "concurrent-cache-torn-file",
                "unrelated:test",
                "unrelated/control.test.ts",
                corrupt_detail,
            ),
            acc,
        );
    }
    Ok(had_miss)
}

fn run_failing_race(
    ctx: &SpecialTimelineCtx<'_>,
    ws_root: &str,
    cache_str: &str,
    acc: &mut WorkerAccumulator,
) -> Result<bool, String> {
    replace_once(
        ctx.workspace_dir,
        "core/math.ts",
        "n * baseScale()",
        "n * baseScale() + 14",
    )?;
    acc.by_mutation
        .entry(ctx.mutation.as_str().to_owned())
        .or_default()
        .oracle_failures += 1;
    acc.oracle_failures_total += 1;

    let barrier = Barrier::new(4);
    let results: Vec<Result<(bool, bool), String>> = thread::scope(|scope| {
        let mut handles = Vec::with_capacity(4);
        for _ in 0..4 {
            handles.push(scope.spawn(|| {
                let mut req = NativeRequestPayload::new("run", ws_root.to_owned());
                req.base = Some(ctx.baseline_sha.to_owned());
                req.cache = true;
                req.cache_dir = Some(cache_str.to_owned());
                barrier.wait();
                let resp = invoke_dad(&ctx.config.dad_bin, &req, ctx.node_dir)?;
                let ui = resp
                    .envelope
                    .result
                    .as_ref()
                    .and_then(|r| r.run.as_ref())
                    .and_then(|run| run.tasks.iter().find(|t| t.id == "ui:test"));
                let caught = ui.is_some_and(|t| {
                    !t.cached && (t.status == "failed" || t.exit_code.is_some_and(|c| c != 0))
                });
                let stale = ui.is_some_and(|t| t.cached);
                Ok((caught, stale))
            }));
        }
        handles
            .into_iter()
            .map(|h| {
                h.join()
                    .map_err(|_| "race fail worker panicked".to_owned())?
            })
            .collect()
    });
    let mut had_miss = false;
    for (idx, res) in results.into_iter().enumerate() {
        let (caught, stale) = res?;
        if !caught {
            had_miss = true;
            record_soundness_miss(
                failure(
                    ctx,
                    if stale {
                        "stale-cache-hit"
                    } else {
                        "concurrent-race-miss"
                    },
                    "ui:test",
                    "ui/tax.test.ts",
                    format!("concurrent failing writer #{idx} did not catch ui:test failure"),
                ),
                stale,
                acc,
            );
        }
    }
    Ok(had_miss)
}

fn inspect_receipts_integrity(cache_dir: &Path) -> Result<Option<String>, String> {
    let dir = cache_dir.join("receipts/v1");
    if !dir.is_dir() {
        return Ok(Some(
            "receipts/v1 directory missing after concurrent writes".to_owned(),
        ));
    }
    let mut json_count = 0usize;
    let entries = fs::read_dir(&dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("entry {}: {e}", dir.display()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".tmp") {
            return Ok(Some(format!(
                "leftover temp file after concurrent writes: {name}"
            )));
        }
        if name.ends_with(".json") {
            json_count += 1;
            let raw = fs::read_to_string(entry.path())
                .map_err(|e| format!("read receipt {name}: {e}"))?;
            if serde_json::from_str::<serde_json::Value>(&raw).is_err() {
                return Ok(Some(format!(
                    "corrupt JSON receipt after concurrent writes: {name}"
                )));
            }
        }
    }
    if json_count == 0 {
        return Ok(Some(
            "zero receipts written during concurrent cache test".to_owned(),
        ));
    }
    Ok(None)
}

fn failure<'a>(
    ctx: &'a SpecialTimelineCtx<'_>,
    kind: &'a str,
    task_id: &'a str,
    test_file: &'a str,
    detail: String,
) -> FailureRecord<'a> {
    FailureRecord {
        config: ctx.config,
        workspace_dir: ctx.workspace_dir,
        shape: ctx.shape,
        step_idx: ctx.step_idx,
        mutation: ctx.mutation,
        kind,
        task_id,
        test_file,
        detail,
    }
}
