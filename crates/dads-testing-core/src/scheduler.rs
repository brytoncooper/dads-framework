//! Running the selected task DAG. The default is deliberately fixed at four workers so the
//! protocol's default behavior is predictable across machines; callers can provide `jobs` to
//! select a different positive bound.
mod batch;
mod cache_ops;
mod progress;
mod receipt_keys;
mod results;
mod stream;
mod vitest_batch;
mod worker;

use crate::execute::{TestingError, message};
use crate::manifest::TestingManifest;
use crate::protocol::{PlanResult, RunResult, TaskRunResult};
use crate::receipts::{TaskReceiptEntry, TaskReceiptStore};
use batch::{WorkUnit, pack_work_units};
use cache_ops::{lookup_receipts_parallel, prepare_tasks, spawn_upload_pool};
use progress::{PreparedTask, RunProgress, TaskStatus, count_outcomes, partition_pending};
use results::{cached_task_result, worker_panic_result};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::mpsc;
use std::thread;
use vitest_batch::execute_vitest_batch;
use worker::execute_task;

const DEFAULT_JOBS: usize = 4;

enum WorkerOutcome {
    SingleOrArgsBatch {
        result: TaskRunResult,
    },
    AttributedBatch {
        results: Vec<(usize, TaskRunResult)>,
    },
}

struct WorkerCompletion {
    worker_id: usize,
    indices: Vec<usize>,
    outcome: WorkerOutcome,
}

struct LoopState {
    progress: RunProgress,
    workers: BTreeMap<usize, thread::JoinHandle<()>>,
    next_worker_id: usize,
    isolated_single: BTreeSet<usize>,
}

pub(crate) fn run_plan(
    manifest: &TestingManifest,
    workspace_root: &Path,
    manifest_file: &Path,
    plan: &PlanResult,
    jobs: Option<u32>,
    receipts: Option<&dyn TaskReceiptStore>,
    stream_enabled: bool,
) -> Result<RunResult, TestingError> {
    let job_limit = job_limit(jobs)?;
    if let Some(store) = receipts {
        store.begin_run();
    }
    let prepared = prepare_tasks(manifest, workspace_root, manifest_file, plan, receipts)?;
    let progress = thread::scope(|scope| {
        let upload_sender = spawn_upload_pool(scope, receipts);
        let outcome = run_scheduler_loop(
            &prepared,
            workspace_root,
            plan,
            job_limit,
            receipts,
            upload_sender.as_ref(),
            stream_enabled,
        );
        drop(upload_sender);
        outcome
    })?;
    count_outcomes(progress)
}

fn run_scheduler_loop(
    prepared: &[PreparedTask],
    workspace_root: &Path,
    plan: &PlanResult,
    job_limit: usize,
    receipts: Option<&dyn TaskReceiptStore>,
    upload_sender: Option<&mpsc::Sender<(String, TaskReceiptEntry)>>,
    stream_enabled: bool,
) -> Result<RunProgress, TestingError> {
    let (sender, receiver) = mpsc::channel::<WorkerCompletion>();
    let mut state = LoopState {
        progress: RunProgress::start(prepared, plan),
        workers: BTreeMap::new(),
        next_worker_id: 0,
        isolated_single: BTreeSet::new(),
    };

    while state.progress.results.iter().any(Option::is_none) {
        let (ready, blocked) = partition_pending(prepared, &state.progress);
        state.progress.block(prepared, &blocked);
        let (to_run, hit_cache) = serve_cached_receipts(
            prepared,
            &ready,
            receipts,
            &mut state.progress,
            stream_enabled,
        );
        let slots = job_limit.saturating_sub(state.workers.len());
        let units = pack_work_units(prepared, &to_run, slots, &state.isolated_single);
        dispatch_units(
            prepared,
            units,
            workspace_root,
            &sender,
            &mut state,
            stream_enabled,
        );

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

        collect_finished(
            &receiver,
            prepared,
            upload_sender,
            &mut state,
            stream_enabled,
        )?;
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

fn serve_cached_receipts(
    prepared: &[PreparedTask],
    ready: &[usize],
    receipts: Option<&dyn TaskReceiptStore>,
    progress: &mut RunProgress,
    stream_enabled: bool,
) -> (Vec<usize>, bool) {
    let Some(store) = receipts else {
        return (ready.to_vec(), false);
    };
    let lookups = lookup_receipts_parallel(store, prepared, ready);
    let mut to_spawn = Vec::new();
    let mut hit_cache = false;
    for (index, maybe_entry) in lookups {
        let task = &prepared[index];
        if let Some(entry) = maybe_entry {
            progress.results[index] =
                Some(cached_task_result(&task.id, entry.stdout, entry.stderr));
            progress
                .statuses
                .insert(task.id.clone(), TaskStatus::Executed);
            progress.counts.executed += 1;
            progress.counts.cached += 1;
            stream::emit_cached(stream_enabled, &task.id);
            hit_cache = true;
            continue;
        }
        to_spawn.push(index);
    }
    (to_spawn, hit_cache)
}

fn dispatch_units(
    prepared: &[PreparedTask],
    units: Vec<WorkUnit>,
    workspace_root: &Path,
    sender: &mpsc::Sender<WorkerCompletion>,
    state: &mut LoopState,
    stream_enabled: bool,
) {
    for unit in units {
        let worker_id = state.next_worker_id;
        state.next_worker_id += 1;
        let indices: Vec<usize> = match &unit {
            WorkUnit::Single(index) => vec![*index],
            WorkUnit::ArgsBatch { indices, .. } | WorkUnit::VitestBatch { indices, .. } => {
                indices.clone()
            }
        };
        let ids_for_stream: Vec<&str> = indices.iter().map(|&i| prepared[i].id.as_str()).collect();
        stream::emit_start(stream_enabled, &ids_for_stream);
        for &index in &indices {
            state
                .progress
                .statuses
                .insert(prepared[index].id.clone(), TaskStatus::Running);
        }
        let root = workspace_root.to_path_buf();
        let task_sender = sender.clone();
        let first_id = prepared[indices[0]].id.clone();
        let worker = match unit {
            WorkUnit::Single(index) => spawn_task_worker(
                worker_id,
                indices,
                first_id,
                prepared[index].execution.clone(),
                root,
                task_sender,
            ),
            WorkUnit::ArgsBatch { execution, .. } => {
                spawn_task_worker(worker_id, indices, first_id, *execution, root, task_sender)
            }
            WorkUnit::VitestBatch {
                execution, members, ..
            } => thread::spawn(move || {
                let panic_members: Vec<(usize, String)> =
                    members.iter().map(|m| (m.index, m.id.clone())).collect();
                let results = match std::panic::catch_unwind(|| {
                    execute_vitest_batch(worker_id, *execution, members, root)
                }) {
                    Ok(results) => results,
                    Err(_) => panic_members
                        .into_iter()
                        .map(|(index, id)| (index, worker_panic_result(&id)))
                        .collect(),
                };
                let _ = task_sender.send(WorkerCompletion {
                    worker_id,
                    indices,
                    outcome: WorkerOutcome::AttributedBatch { results },
                });
            }),
        };
        state.workers.insert(worker_id, worker);
    }
}

fn spawn_task_worker(
    worker_id: usize,
    indices: Vec<usize>,
    task_id: String,
    execution: crate::manifest::TaskExecution,
    root: std::path::PathBuf,
    sender: mpsc::Sender<WorkerCompletion>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let panic_id = task_id.clone();
        let result = match std::panic::catch_unwind(|| execute_task(task_id, execution, root)) {
            Ok(result) => result,
            Err(_) => worker_panic_result(&panic_id),
        };
        let _ = sender.send(WorkerCompletion {
            worker_id,
            indices,
            outcome: WorkerOutcome::SingleOrArgsBatch { result },
        });
    })
}

fn collect_finished(
    receiver: &mpsc::Receiver<WorkerCompletion>,
    prepared: &[PreparedTask],
    upload_sender: Option<&mpsc::Sender<(String, TaskReceiptEntry)>>,
    state: &mut LoopState,
    stream_enabled: bool,
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
            stream::emit_finish(stream_enabled, &result);
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
                let first_id = prepared[completion.indices[0]].id.as_str();
                stream::emit_batch_fallback(stream_enabled, completion.indices.len(), first_id);
                for index in completion.indices {
                    state.isolated_single.insert(index);
                    state
                        .progress
                        .statuses
                        .insert(prepared[index].id.clone(), TaskStatus::Pending);
                }
                return Ok(());
            }
            record_unit_outcome(
                completion.indices,
                result,
                prepared,
                upload_sender,
                &mut state.progress,
                stream_enabled,
            );
        }
        WorkerOutcome::AttributedBatch { results } => {
            for (index, task_result) in results {
                record_single_outcome(
                    index,
                    task_result,
                    prepared,
                    upload_sender,
                    &mut state.progress,
                    stream_enabled,
                );
            }
        }
    }
    Ok(())
}

fn record_unit_outcome(
    indices: Vec<usize>,
    outcome: TaskRunResult,
    prepared: &[PreparedTask],
    upload_sender: Option<&mpsc::Sender<(String, TaskReceiptEntry)>>,
    progress: &mut RunProgress,
    stream_enabled: bool,
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
        };
        record_single_outcome(
            index,
            task_result,
            prepared,
            upload_sender,
            progress,
            stream_enabled,
        );
    }
}

fn record_single_outcome(
    index: usize,
    task_result: TaskRunResult,
    prepared: &[PreparedTask],
    upload_sender: Option<&mpsc::Sender<(String, TaskReceiptEntry)>>,
    progress: &mut RunProgress,
    stream_enabled: bool,
) {
    let task = &prepared[index];
    let status = if task_result.status == "executed" {
        TaskStatus::Executed
    } else {
        TaskStatus::Failed
    };
    let should_cache = status == TaskStatus::Executed && task_result.exit_code == Some(0);
    if should_cache
        && let Some(sender) = upload_sender
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
    stream::emit_finish(stream_enabled, &task_result);
    progress.counts.executed += 1;
    if status == TaskStatus::Failed {
        progress.counts.failed += 1;
    }
    progress.statuses.insert(task.id.clone(), status);
    progress.results[index] = Some(task_result);
}
