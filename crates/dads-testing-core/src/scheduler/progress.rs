//! Execution progress state, dependency readiness, and path rebasing for the scheduler.

use super::results::{blocked_result, not_applicable_result};
use crate::execute::{TestingError, message};
use crate::manifest::TaskExecution;
use crate::protocol::{PlanResult, RunCounts, RunResult, TaskRunResult};
use std::collections::BTreeMap;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum TaskStatus {
    Pending,
    Running,
    Executed,
    Failed,
    Blocked,
    NotApplicable,
}

pub(super) struct PreparedTask {
    pub(super) id: String,
    pub(super) dependencies: Vec<String>,
    pub(super) execution: TaskExecution,
    pub(super) receipt_key: Option<String>,
    pub(super) cache: bool,
    pub(super) selected_files: Vec<String>,
    pub(super) base_args_len: usize,
}

/// What the run knows so far, indexed the same way `prepared` is: a task's result, its status,
/// and the running outcome tally the response reports.
pub(super) struct RunProgress {
    pub(super) statuses: BTreeMap<String, TaskStatus>,
    pub(super) results: Vec<Option<TaskRunResult>>,
    pub(super) counts: RunCounts,
}

impl RunProgress {
    /// A task the plan did not select is already finished before the run begins.
    pub(super) fn start(prepared: &[PreparedTask], plan: &PlanResult) -> Self {
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

    pub(super) fn block(&mut self, prepared: &[PreparedTask], blocked: &[usize]) {
        for &index in blocked {
            let task = &prepared[index];
            let result = blocked_result(&task.id, &task.dependencies, &self.statuses);
            self.results[index] = Some(result);
            self.statuses.insert(task.id.clone(), TaskStatus::Blocked);
            self.counts.blocked += 1;
        }
    }

    pub(super) fn unresolved<'a>(&self, prepared: &'a [PreparedTask]) -> Vec<&'a str> {
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
pub(super) fn partition_pending(
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

/// A run exits non-zero when anything failed or was blocked, whether or not the failure was the
/// task the caller cared about.
pub(super) fn count_outcomes(progress: RunProgress) -> Result<RunResult, TestingError> {
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
pub(super) fn rebase_file_for_cwd(file: &str, cwd: Option<&str>) -> String {
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
