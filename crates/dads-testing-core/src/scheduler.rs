//! Running the selected task DAG. The default is deliberately fixed at four workers so the
//! protocol's default behavior is predictable across machines; callers can provide `jobs` to
//! select a different positive bound.
mod audit_per_file;
mod batch;
mod cache_ops;
mod dispatch;
mod progress;
mod read_guard;
mod read_guard_allowlist;
mod read_guard_gitignore;
mod receipt_keys;
mod results;
mod stream;
mod vitest_batch;
mod vitest_report;
mod worker;

#[cfg(test)]
pub(crate) use stream::write_finish;

pub(crate) use read_guard::should_guard_task;
pub(crate) use read_guard_allowlist::AllowlistBuilder;

use crate::execute::{TestingError, message};
use crate::graph::DependencyGraph;
use crate::manifest::TestingManifest;
use crate::protocol::{PlanResult, ReadGuardMode, RunResult, TaskRunResult};
use crate::receipts::{TaskReceiptEntry, TaskReceiptStore};
use batch::pack_work_units;
use cache_ops::{prepare_tasks, serve_cached_receipts, spawn_upload_pool};
use dispatch::{WorkerCompletion, WorkerOutcome, dispatch_units};
use progress::{PreparedTask, RunProgress, TaskStatus, count_outcomes, partition_pending};
use read_guard::ReadGuardSession;
use results::worker_panic_result;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Arc, mpsc};
use std::thread;

const DEFAULT_JOBS: usize = 4;

pub(crate) struct RunOptions<'a> {
    pub(crate) jobs: Option<u32>,
    pub(crate) receipts: Option<&'a dyn TaskReceiptStore>,
    pub(crate) stream_enabled: bool,
    pub(crate) graph: Option<&'a DependencyGraph>,
    pub(crate) read_guard_mode: Option<ReadGuardMode>,
    pub(crate) read_guard_hook_path: Option<&'a str>,
    pub(crate) workspace_root_raw: &'a Path,
    pub(crate) audit_per_file: bool,
}

struct LoopState {
    progress: RunProgress,
    workers: BTreeMap<usize, thread::JoinHandle<()>>,
    next_worker_id: usize,
    isolated_single: BTreeSet<usize>,
    checked_cache: Vec<bool>,
}

struct LoopContext<'a> {
    workspace_root: &'a Path,
    job_limit: usize,
    receipts: Option<&'a dyn TaskReceiptStore>,
    upload_sender: Option<&'a mpsc::Sender<(String, TaskReceiptEntry)>>,
    stream_enabled: bool,
    read_guard: Option<Arc<ReadGuardSession>>,
}

pub(crate) fn run_plan(
    manifest: &TestingManifest,
    workspace_root: &Path,
    manifest_file: &Path,
    plan: &PlanResult,
    options: RunOptions<'_>,
) -> Result<RunResult, TestingError> {
    if options.read_guard_mode == Some(ReadGuardMode::Audit) && options.audit_per_file {
        return audit_per_file::run_plan_audit_per_file(
            manifest,
            workspace_root,
            manifest_file,
            plan,
            options,
        );
    }
    run_plan_once(manifest, workspace_root, manifest_file, plan, options)
}

pub(super) fn run_plan_once(
    manifest: &TestingManifest,
    workspace_root: &Path,
    manifest_file: &Path,
    plan: &PlanResult,
    options: RunOptions<'_>,
) -> Result<RunResult, TestingError> {
    let job_limit = job_limit(options.jobs)?;
    if let Some(store) = options.receipts {
        store.begin_run();
    }
    let read_guard = match options.read_guard_mode {
        Some(mode) => Some(Arc::new(ReadGuardSession::start(
            mode,
            workspace_root,
            options.workspace_root_raw,
            options.read_guard_hook_path,
        )?)),
        None => None,
    };
    let prepared = prepare_tasks(
        manifest,
        workspace_root,
        manifest_file,
        plan,
        options.receipts,
        options.graph,
        read_guard.is_some(),
    )?;
    let progress = thread::scope(|scope| {
        let upload_sender = spawn_upload_pool(scope, options.receipts);
        let ctx = LoopContext {
            workspace_root,
            job_limit,
            receipts: options.receipts,
            upload_sender: upload_sender.as_ref(),
            stream_enabled: options.stream_enabled,
            read_guard,
        };
        let outcome = run_scheduler_loop(&prepared, plan, &ctx);
        drop(upload_sender);
        outcome
    })?;
    count_outcomes(progress)
}

fn run_scheduler_loop(
    prepared: &[PreparedTask],
    plan: &PlanResult,
    ctx: &LoopContext<'_>,
) -> Result<RunProgress, TestingError> {
    let (sender, receiver) = mpsc::channel::<WorkerCompletion>();
    let mut state = LoopState {
        progress: RunProgress::start(prepared, plan),
        workers: BTreeMap::new(),
        next_worker_id: 0,
        isolated_single: BTreeSet::new(),
        checked_cache: vec![false; prepared.len()],
    };
    let disable_guarded_batching = ctx
        .read_guard
        .as_ref()
        .is_some_and(|session| session.mode() == ReadGuardMode::Audit);

    while state.progress.results.iter().any(Option::is_none) {
        let (ready, blocked) = partition_pending(prepared, &state.progress);
        state.progress.block(prepared, &blocked);
        let (to_run, hit_cache) = serve_cached_receipts(
            prepared,
            &ready,
            ctx.receipts,
            &mut state.checked_cache,
            &mut state.progress,
            ctx.stream_enabled,
        );
        let slots = ctx.job_limit.saturating_sub(state.workers.len());
        let units = pack_work_units(
            prepared,
            &to_run,
            slots,
            &state.isolated_single,
            disable_guarded_batching,
        );
        dispatch_units(prepared, units, ctx, &sender, &mut state);

        if state.workers.is_empty() {
            let unresolved = state.progress.unresolved(prepared);
            if unresolved.is_empty() || !blocked.is_empty() || hit_cache {
                continue;
            }
            return Err(message(format!(
                "No runnable tasks remain; unresolved tasks: {}.",
                unresolved.join(", ")
            )));
        }

        collect_finished(&receiver, prepared, ctx, &mut state)?;
    }
    Ok(state.progress)
}

fn job_limit(jobs: Option<u32>) -> Result<usize, TestingError> {
    match jobs {
        Some(0) => Err(message("jobs must be greater than zero.")),
        Some(value) => usize::try_from(value)
            .map_err(|_| message("jobs exceeds this platform's supported range.")),
        None => Ok(DEFAULT_JOBS),
    }
}

fn isolate_batch(
    indices: &[usize],
    prepared: &[PreparedTask],
    state: &mut LoopState,
    stream_enabled: bool,
) {
    let first_id = prepared[indices[0]].id.as_str();
    stream::emit_batch_fallback(stream_enabled, indices.len(), first_id);
    for &index in indices {
        state.isolated_single.insert(index);
        state
            .progress
            .statuses
            .insert(prepared[index].id.clone(), TaskStatus::Pending);
    }
}

fn collect_finished(
    receiver: &mpsc::Receiver<WorkerCompletion>,
    prepared: &[PreparedTask],
    ctx: &LoopContext<'_>,
    state: &mut LoopState,
) -> Result<(), TestingError> {
    let completion = receiver
        .recv()
        .map_err(|error| message(format!("Testing task worker channel failed: {error}")))?;
    let panicked = state
        .workers
        .remove(&completion.worker_id)
        .is_some_and(|worker| worker.join().is_err());
    if panicked {
        for index in completion.indices {
            let task = &prepared[index];
            let result = worker_panic_result(&task.id);
            stream::emit_finish(ctx.stream_enabled, &result);
            state.progress.results[index] = Some(result);
            state
                .progress
                .statuses
                .insert(task.id.clone(), TaskStatus::Failed);
            state.progress.counts.executed += 1;
            state.progress.counts.failed += 1;
        }
        return Ok(());
    }
    match completion.outcome {
        WorkerOutcome::SingleOrArgsBatch { result } => {
            let succeeded = result.status == "executed" && result.exit_code == Some(0);
            if !succeeded && completion.indices.len() > 1 {
                isolate_batch(&completion.indices, prepared, state, ctx.stream_enabled);
                return Ok(());
            }
            record_unit_outcome(
                completion.indices,
                result,
                prepared,
                ctx,
                &mut state.progress,
            );
        }
        WorkerOutcome::AttributedBatch {
            results,
            isolate_for_read_guard,
        } => {
            if isolate_for_read_guard && completion.indices.len() > 1 {
                isolate_batch(&completion.indices, prepared, state, ctx.stream_enabled);
                return Ok(());
            }
            for (index, task_result) in results {
                record_single_outcome(index, task_result, prepared, ctx, &mut state.progress);
            }
        }
    }
    Ok(())
}

fn record_unit_outcome(
    indices: Vec<usize>,
    outcome: TaskRunResult,
    prepared: &[PreparedTask],
    ctx: &LoopContext<'_>,
    progress: &mut RunProgress,
) {
    for index in indices {
        let task = &prepared[index];
        let task_result = TaskRunResult {
            id: task.id.clone(),
            status: outcome.status.clone(),
            exit_code: outcome.exit_code,
            duration_ms: outcome.duration_ms,
            stdout: outcome.stdout.clone(),
            stderr: outcome.stderr.clone(),
            error: outcome.error.clone(),
            cached: outcome.cached,
            undeclared_reads: outcome.undeclared_reads.clone(),
        };
        record_single_outcome(index, task_result, prepared, ctx, progress);
    }
}

fn record_single_outcome(
    index: usize,
    task_result: TaskRunResult,
    prepared: &[PreparedTask],
    ctx: &LoopContext<'_>,
    progress: &mut RunProgress,
) {
    let task = &prepared[index];
    let status = if task_result.status == "executed" {
        TaskStatus::Executed
    } else {
        TaskStatus::Failed
    };
    let should_cache = status == TaskStatus::Executed
        && task_result.exit_code == Some(0)
        && task_result.undeclared_reads.is_empty();
    if should_cache
        && let Some(sender) = ctx.upload_sender
        && let Some(key) = task.receipt_key.as_ref()
    {
        let _ = sender.send((
            key.clone(),
            TaskReceiptEntry {
                stdout: task_result.stdout.clone(),
                stderr: task_result.stderr.clone(),
            },
        ));
    }
    stream::emit_finish(ctx.stream_enabled, &task_result);
    progress.counts.executed += 1;
    if status == TaskStatus::Failed {
        progress.counts.failed += 1;
    }
    progress.statuses.insert(task.id.clone(), status);
    progress.results[index] = Some(task_result);
}
