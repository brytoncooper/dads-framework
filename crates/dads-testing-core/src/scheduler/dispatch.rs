//! Worker thread spawning and unit dispatch for the scheduler loop.

use super::batch::WorkUnit;
use super::progress::{PreparedTask, TaskStatus};
use super::read_guard::ReadGuardSession;
use super::read_guard_allowlist::TaskReadGuardAllowlist;
use super::results::worker_panic_result;
use super::stream;
use super::vitest_batch::execute_vitest_batch;
use super::worker::execute_task;
use super::{LoopContext, LoopState};
use crate::protocol::TaskRunResult;
use std::sync::{Arc, mpsc};
use std::thread;

pub(super) type WorkerGuard = Option<(Arc<ReadGuardSession>, TaskReadGuardAllowlist)>;

pub(super) enum WorkerOutcome {
    SingleOrArgsBatch {
        result: TaskRunResult,
    },
    AttributedBatch {
        results: Vec<(usize, TaskRunResult)>,
        isolate_for_read_guard: bool,
    },
}

pub(super) struct WorkerCompletion {
    pub(super) worker_id: usize,
    pub(super) indices: Vec<usize>,
    pub(super) outcome: WorkerOutcome,
}

pub(super) fn dispatch_units(
    prepared: &[PreparedTask],
    units: Vec<WorkUnit>,
    ctx: &LoopContext<'_>,
    sender: &mpsc::Sender<WorkerCompletion>,
    state: &mut LoopState,
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
        stream::emit_start(ctx.stream_enabled, &ids_for_stream);
        for &index in &indices {
            state
                .progress
                .statuses
                .insert(prepared[index].id.clone(), TaskStatus::Running);
        }
        let root = ctx.workspace_root.to_path_buf();
        let task_sender = sender.clone();
        let first_id = prepared[indices[0]].id.clone();
        let worker_guard = batch_guard_for_indices(prepared, &indices, ctx.read_guard.as_ref());
        let worker = match unit {
            WorkUnit::Single(index) => spawn_task_worker(
                worker_id,
                indices,
                first_id,
                prepared[index].execution.clone(),
                root,
                worker_guard,
                task_sender,
            ),
            WorkUnit::ArgsBatch { execution, .. } => spawn_task_worker(
                worker_id,
                indices,
                first_id,
                *execution,
                root,
                worker_guard,
                task_sender,
            ),
            WorkUnit::VitestBatch {
                execution, members, ..
            } => spawn_vitest_worker(
                worker_id,
                indices,
                *execution,
                members,
                root,
                worker_guard,
                task_sender,
            ),
        };
        state.workers.insert(worker_id, worker);
    }
}

fn batch_guard_for_indices(
    prepared: &[PreparedTask],
    indices: &[usize],
    read_guard: Option<&Arc<ReadGuardSession>>,
) -> WorkerGuard {
    let session = read_guard?;
    let allowlists: Vec<&TaskReadGuardAllowlist> = indices
        .iter()
        .filter_map(|&idx| prepared[idx].allowlist.as_ref())
        .collect();
    if allowlists.is_empty() {
        return None;
    }
    Some((
        Arc::clone(session),
        TaskReadGuardAllowlist::merge_many(allowlists),
    ))
}

fn spawn_task_worker(
    worker_id: usize,
    indices: Vec<usize>,
    task_id: String,
    execution: crate::manifest::TaskExecution,
    root: std::path::PathBuf,
    worker_guard: WorkerGuard,
    sender: mpsc::Sender<WorkerCompletion>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let panic_id = task_id.clone();
        let result = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let guard_ref = worker_guard
                .as_ref()
                .map(|(session, allowlist)| (session.as_ref(), allowlist, worker_id));
            execute_task(task_id, execution, root, guard_ref)
        })) {
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

fn spawn_vitest_worker(
    worker_id: usize,
    indices: Vec<usize>,
    execution: crate::manifest::TaskExecution,
    members: Vec<super::vitest_batch::VitestBatchMember>,
    root: std::path::PathBuf,
    worker_guard: WorkerGuard,
    sender: mpsc::Sender<WorkerCompletion>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let panic_members: Vec<(usize, String)> =
            members.iter().map(|m| (m.index, m.id.clone())).collect();
        let (results, isolate_for_read_guard) =
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let guard_ref = worker_guard
                    .as_ref()
                    .map(|(session, allowlist)| (session.as_ref(), allowlist));
                execute_vitest_batch(worker_id, execution, members, root, guard_ref)
            })) {
                Ok(outcome) => outcome,
                Err(_) => (
                    panic_members
                        .into_iter()
                        .map(|(index, id)| (index, worker_panic_result(&id)))
                        .collect(),
                    false,
                ),
            };
        let _ = sender.send(WorkerCompletion {
            worker_id,
            indices,
            outcome: WorkerOutcome::AttributedBatch {
                results,
                isolate_for_read_guard,
            },
        });
    })
}
