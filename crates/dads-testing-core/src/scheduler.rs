//! Running the selected task DAG. The default is deliberately fixed at four workers so the
//! protocol's default behavior is predictable across machines; callers can provide `jobs` to
//! select a different positive bound.
mod receipt_keys;
mod results;
mod worker;

use crate::execute::{TestingError, message};
use crate::manifest::{DeclaredTask, TaskExecution, TestingManifest};
use crate::protocol::{PlanResult, RunCounts, RunResult, TaskRunResult};
use crate::receipts::{TaskReceiptEntry, TaskReceiptStore};
use receipt_keys::compute_task_receipt_key;
use results::{blocked_result, cached_task_result, not_applicable_result, worker_panic_result};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::mpsc;
use std::thread;
use worker::execute_task;

const DEFAULT_JOBS: usize = 4;

#[derive(Clone, Copy, PartialEq, Eq)]
enum TaskStatus {
    Pending,
    Running,
    Executed,
    Failed,
    Blocked,
    NotApplicable,
}

struct PreparedTask {
    id: String,
    dependencies: Vec<String>,
    execution: TaskExecution,
    receipt_key: Option<String>,
}

struct TaskCompletion {
    index: usize,
    result: TaskRunResult,
}

/// What the run knows so far, indexed the same way `prepared` is: a task's result, its status,
/// and the running outcome tally the response reports.
struct RunProgress {
    statuses: BTreeMap<String, TaskStatus>,
    results: Vec<Option<TaskRunResult>>,
    counts: RunCounts,
}

pub(crate) fn run_plan(
    manifest: &TestingManifest,
    workspace_root: &Path,
    manifest_file: &Path,
    plan: &PlanResult,
    jobs: Option<u32>,
    receipts: Option<&dyn TaskReceiptStore>,
) -> Result<RunResult, TestingError> {
    let job_limit = job_limit(jobs)?;
    let prepared = prepare_tasks(manifest, workspace_root, manifest_file, plan, receipts)?;
    let (sender, receiver) = mpsc::channel::<TaskCompletion>();
    let mut progress = RunProgress::start(&prepared, plan);
    let mut workers = BTreeMap::new();

    while progress.results.iter().any(Option::is_none) {
        let (ready, blocked) = partition_pending(&prepared, &progress);
        progress.block(&prepared, &blocked);
        let (mut to_spawn, hit_cache) =
            serve_cached_receipts(&prepared, &ready, receipts, &mut progress);
        to_spawn.truncate(job_limit.saturating_sub(workers.len()));
        dispatch_ready(
            &prepared,
            &to_spawn,
            workspace_root,
            &sender,
            &mut workers,
            &mut progress,
        );

        if workers.is_empty() {
            let unresolved = progress.unresolved(&prepared);
            if unresolved.is_empty() || !blocked.is_empty() || hit_cache {
                continue;
            }
            return Err(message(format!(
                "No runnable tasks remain; unresolved tasks: {}.",
                unresolved.join(", ")
            )));
        }

        collect_finished(&receiver, &mut workers, &prepared, receipts, &mut progress)?;
    }

    count_outcomes(progress)
}

fn job_limit(jobs: Option<u32>) -> Result<usize, TestingError> {
    match jobs {
        Some(0) => Err(message("jobs must be greater than zero.")),
        Some(value) => usize::try_from(value)
            .map_err(|_| message("jobs exceeds this platform's supported range.")),
        None => Ok(DEFAULT_JOBS),
    }
}

/// The planned decisions resolved against the manifest, in plan order, so every later step can
/// address a task by index instead of looking it up again.
fn prepare_tasks(
    manifest: &TestingManifest,
    workspace_root: &Path,
    manifest_file: &Path,
    plan: &PlanResult,
    receipts: Option<&dyn TaskReceiptStore>,
) -> Result<Vec<PreparedTask>, TestingError> {
    let declared: BTreeMap<&str, &DeclaredTask> = manifest
        .tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect();
    let planned_ids: std::collections::BTreeSet<&str> =
        plan.tasks.iter().map(|d| d.id.as_str()).collect();
    plan.tasks
        .iter()
        .map(|decision| {
            let task = declared
                .get(decision.id.as_str())
                .ok_or_else(|| message(format!("Unknown task {}.", decision.id)))?;
            let mut execution = task.execution.clone();
            if !decision.selected_files.is_empty() {
                for file in &decision.selected_files {
                    execution
                        .args
                        .push(rebase_file_for_cwd(file, execution.cwd.as_deref()));
                }
            }
            let receipt_key = if decision.decision == "run" {
                compute_task_receipt_key(
                    receipts,
                    manifest,
                    task,
                    &execution,
                    &decision.selected_files,
                    manifest_file,
                    workspace_root,
                )
            } else {
                None
            };
            let dependencies = task
                .depends_on
                .iter()
                .filter(|dep| planned_ids.contains(dep.as_str()))
                .cloned()
                .collect();
            Ok(PreparedTask {
                id: task.id.clone(),
                dependencies,
                execution,
                receipt_key,
            })
        })
        .collect::<Result<Vec<_>, TestingError>>()
}

fn serve_cached_receipts(
    prepared: &[PreparedTask],
    ready: &[usize],
    receipts: Option<&dyn TaskReceiptStore>,
    progress: &mut RunProgress,
) -> (Vec<usize>, bool) {
    let Some(store) = receipts else {
        return (ready.to_vec(), false);
    };
    let mut to_spawn = Vec::new();
    let mut hit_cache = false;
    for &index in ready {
        let task = &prepared[index];
        if let Some(key) = task.receipt_key.as_deref()
            && let Some(entry) = store.lookup(key)
        {
            progress.results[index] =
                Some(cached_task_result(&task.id, entry.stdout, entry.stderr));
            progress
                .statuses
                .insert(task.id.clone(), TaskStatus::Executed);
            progress.counts.executed += 1;
            progress.counts.cached += 1;
            hit_cache = true;
            continue;
        }
        to_spawn.push(index);
    }
    (to_spawn, hit_cache)
}

impl RunProgress {
    /// A task the plan did not select is already finished before the run begins.
    fn start(prepared: &[PreparedTask], plan: &PlanResult) -> Self {
        let mut statuses = BTreeMap::new();
        let mut results = (0..prepared.len())
            .map(|_| None)
            .collect::<Vec<Option<TaskRunResult>>>();
        let mut counts = RunCounts {
            executed: 0,
            failed: 0,
            blocked: 0,
            not_applicable: 0,
            cached: 0,
        };
        for (index, decision) in plan.tasks.iter().enumerate() {
            if decision.decision != "run" {
                let task = &prepared[index];
                results[index] = Some(not_applicable_result(&task.id));
                statuses.insert(task.id.clone(), TaskStatus::NotApplicable);
                counts.not_applicable += 1;
            } else {
                statuses.insert(prepared[index].id.clone(), TaskStatus::Pending);
            }
        }
        Self {
            statuses,
            results,
            counts,
        }
    }

    fn block(&mut self, prepared: &[PreparedTask], blocked: &[usize]) {
        for &index in blocked {
            let task = &prepared[index];
            let result = blocked_result(&task.id, &task.dependencies, &self.statuses);
            self.results[index] = Some(result);
            self.statuses.insert(task.id.clone(), TaskStatus::Blocked);
            self.counts.blocked += 1;
        }
    }

    fn unresolved<'a>(&self, prepared: &'a [PreparedTask]) -> Vec<&'a str> {
        prepared
            .iter()
            .enumerate()
            .filter(|(index, _)| self.results[*index].is_none())
            .map(|(_, task)| task.id.as_str())
            .collect()
    }
}

/// Pending tasks split by what their prerequisites have already done: runnable now, or blocked
/// because a prerequisite will never succeed. A task still waiting appears in neither.
fn partition_pending(
    prepared: &[PreparedTask],
    progress: &RunProgress,
) -> (Vec<usize>, Vec<usize>) {
    let mut ready = Vec::new();
    let mut blocked = Vec::new();
    for (index, task) in prepared.iter().enumerate() {
        if progress.results[index].is_some()
            || progress.statuses.get(&task.id) != Some(&TaskStatus::Pending)
        {
            continue;
        }
        match dependency_state(&task.dependencies, &progress.statuses) {
            DependencyState::Ready => ready.push(index),
            DependencyState::Blocked => blocked.push(index),
            DependencyState::Waiting => {}
        }
    }
    (ready, blocked)
}

/// Starts one worker thread per ready task. A worker that panics still reports an outcome, so a
/// panicking task cannot leave the run waiting on a result that never arrives.
fn dispatch_ready(
    prepared: &[PreparedTask],
    ready: &[usize],
    workspace_root: &Path,
    sender: &mpsc::Sender<TaskCompletion>,
    workers: &mut BTreeMap<usize, thread::JoinHandle<()>>,
    progress: &mut RunProgress,
) {
    for &index in ready {
        let task = &prepared[index];
        let task_id = task.id.clone();
        let execution = task.execution.clone();
        let root = workspace_root.to_path_buf();
        let task_sender = sender.clone();
        let worker = thread::spawn(move || {
            let panic_task_id = task_id.clone();
            let result = match std::panic::catch_unwind(|| execute_task(task_id, execution, root)) {
                Ok(result) => result,
                Err(_) => worker_panic_result(&panic_task_id),
            };
            let _ = task_sender.send(TaskCompletion { index, result });
        });
        workers.insert(index, worker);
        progress
            .statuses
            .insert(task.id.clone(), TaskStatus::Running);
    }
}

/// Waits for exactly one worker to finish and records what it reported.
fn collect_finished(
    receiver: &mpsc::Receiver<TaskCompletion>,
    workers: &mut BTreeMap<usize, thread::JoinHandle<()>>,
    prepared: &[PreparedTask],
    receipts: Option<&dyn TaskReceiptStore>,
    progress: &mut RunProgress,
) -> Result<(), TestingError> {
    let completion = receiver
        .recv()
        .map_err(|error| message(format!("Testing task worker channel failed: {error}")))?;
    if let Some(worker) = workers.remove(&completion.index)
        && worker.join().is_err()
    {
        let task = &prepared[completion.index];
        progress.results[completion.index] = Some(worker_panic_result(&task.id));
        progress
            .statuses
            .insert(task.id.clone(), TaskStatus::Failed);
        progress.counts.executed += 1;
        progress.counts.failed += 1;
        return Ok(());
    }
    let status = if completion.result.status == "executed" {
        TaskStatus::Executed
    } else {
        TaskStatus::Failed
    };
    if status == TaskStatus::Executed
        && completion.result.exit_code == Some(0)
        && let Some(store) = receipts
        && let Some(key) = prepared[completion.index].receipt_key.as_deref()
    {
        store.record_pass(
            key,
            &TaskReceiptEntry {
                stdout: completion.result.stdout.clone(),
                stderr: completion.result.stderr.clone(),
            },
        );
    }
    progress.counts.executed += 1;
    if status == TaskStatus::Failed {
        progress.counts.failed += 1;
    }
    progress
        .statuses
        .insert(prepared[completion.index].id.clone(), status);
    progress.results[completion.index] = Some(completion.result);
    Ok(())
}

/// A run exits non-zero when anything failed or was blocked, whether or not the failure was the
/// task the caller cared about.
fn count_outcomes(progress: RunProgress) -> Result<RunResult, TestingError> {
    let tasks = progress
        .results
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| message("Scheduler completed without a result for every planned task."))?;
    let exit_code = if progress.counts.failed > 0 || progress.counts.blocked > 0 {
        1
    } else {
        0
    };
    Ok(RunResult {
        tasks,
        counts: progress.counts,
        exit_code,
    })
}

enum DependencyState {
    Ready,
    Waiting,
    Blocked,
}

fn dependency_state(
    dependencies: &[String],
    statuses: &BTreeMap<String, TaskStatus>,
) -> DependencyState {
    let mut waiting = false;
    for dependency in dependencies {
        match statuses.get(dependency) {
            Some(TaskStatus::Executed) => {}
            Some(TaskStatus::Failed | TaskStatus::Blocked | TaskStatus::NotApplicable) | None => {
                return DependencyState::Blocked;
            }
            Some(TaskStatus::Pending | TaskStatus::Running) => waiting = true,
        }
    }
    if waiting {
        DependencyState::Waiting
    } else {
        DependencyState::Ready
    }
}

/// Converts a workspace-relative selected test file path to be relative to `execution.cwd` when
/// the task runs from a subdirectory (for example a package root).
fn rebase_file_for_cwd(file: &str, cwd: Option<&str>) -> String {
    let Some(cwd) = cwd else {
        return file.to_owned();
    };
    let trimmed = cwd.trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "." {
        return file.to_owned();
    }
    let prefix = format!("{trimmed}/");
    file.strip_prefix(&prefix).unwrap_or(file).to_owned()
}
