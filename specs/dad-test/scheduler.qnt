// Quint specification for Dads Testing parallel DAG scheduler
// (models crates/dads-testing-core/src/scheduler.rs)
//
// Verifies across all concurrent worker interleavings, worker panics, failures,
// and prerequisite-closed plans:
//   1. Concurrency bound: active running workers never exceed `JOB_LIMIT`
//   2. Prerequisite ordering: no task starts or completes before all dependencies execute
//   3. Failure propagation: any failed/blocked/not_applicable dependency blocks dependents
//   4. Clean exit soundness: exit_code == 0 iff zero failed and zero blocked tasks

module scheduler {
  type TaskId = str
  type Status = str // "pending" | "running" | "executed" | "failed" | "blocked" | "not_applicable"

  // 4-task diamond DAG:
  //   build_core -> build_http -> test_http
  //   build_core -> test_core  -> test_http
  val ALL_TASKS: Set[TaskId] = Set("build_core", "build_http", "test_core", "test_http")
  val JOB_LIMIT: int = 2

  pure def depsOf(t: TaskId): Set[TaskId] =
    if (t == "build_core") Set()
    else if (t == "build_http") Set("build_core")
    else if (t == "test_core") Set("build_core")
    else Set("build_http", "test_core")

  // Plan validity precondition guaranteed by Lean 4 Theorem 1 (`buildPlan_prereq_closed`):
  // whenever a task is selected, all its dependencies are also selected.
  pure def isPrereqClosed(selected: Set[TaskId]): bool =
    selected.forall(t => depsOf(t).subseteq(selected))

  var selectedTasks: Set[TaskId]
  var statuses: TaskId -> Status
  var executedCount: int
  var failedCount: int
  var blockedCount: int
  var notApplicableCount: int

  pure def runningTasks(st: TaskId -> Status): Set[TaskId] =
    ALL_TASKS.filter(t => st.get(t) == "running")

  pure def isTerminal(s: Status): bool =
    s == "executed" or s == "failed" or s == "blocked" or s == "not_applicable"

  pure def depState(t: TaskId, st: TaskId -> Status): str =
    if (depsOf(t).exists(d =>
      st.get(d) == "failed" or st.get(d) == "blocked" or st.get(d) == "not_applicable"
    )) "blocked"
    else if (depsOf(t).forall(d => st.get(d) == "executed")) "ready"
    else "waiting"

  action init = {
    nondet sel = ALL_TASKS.powerset().filter(s => isPrereqClosed(s)).oneOf()
    all {
      selectedTasks' = sel,
      statuses' = ALL_TASKS.mapBy(t =>
        if (sel.contains(t)) "pending" else "not_applicable"
      ),
      executedCount' = 0,
      failedCount' = 0,
      blockedCount' = 0,
      notApplicableCount' = ALL_TASKS.exclude(sel).size()
    }
  }

  // Block any pending task whose dependency failed, blocked, or was not_applicable.
  action blockPendingTask = {
    val blockable = ALL_TASKS.filter(t =>
      statuses.get(t) == "pending" and depState(t, statuses) == "blocked"
    )
    all {
      blockable.size() > 0,
      nondet t = blockable.oneOf()
      all {
        statuses' = statuses.set(t, "blocked"),
        blockedCount' = blockedCount + 1,
        selectedTasks' = selectedTasks,
        executedCount' = executedCount,
        failedCount' = failedCount,
        notApplicableCount' = notApplicableCount
      }
    }
  }

  // Dispatch a ready task if worker capacity allows.
  action dispatchReadyTask = {
    val ready = ALL_TASKS.filter(t =>
      statuses.get(t) == "pending" and depState(t, statuses) == "ready"
    )
    all {
      ready.size() > 0,
      runningTasks(statuses).size() < JOB_LIMIT,
      nondet t = ready.oneOf()
      all {
        statuses' = statuses.set(t, "running"),
        selectedTasks' = selectedTasks,
        executedCount' = executedCount,
        failedCount' = failedCount,
        blockedCount' = blockedCount,
        notApplicableCount' = notApplicableCount
      }
    }
  }

  // Complete a running worker with pass, fail, or caught panic (recorded as failed).
  action completeRunningTask = {
    val running = runningTasks(statuses)
    all {
      running.size() > 0,
      nondet t = running.oneOf()
      nondet succeeded = Set(true, false).oneOf()
      all {
        statuses' = statuses.set(t, if (succeeded) "executed" else "failed"),
        executedCount' = executedCount + 1,
        failedCount' = if (succeeded) failedCount else failedCount + 1,
        selectedTasks' = selectedTasks,
        blockedCount' = blockedCount,
        notApplicableCount' = notApplicableCount
      }
    }
  }

  // Stutter once all tasks reach a terminal state.
  action doneStutter = all {
    ALL_TASKS.forall(t => isTerminal(statuses.get(t))),
    selectedTasks' = selectedTasks,
    statuses' = statuses,
    executedCount' = executedCount,
    failedCount' = failedCount,
    blockedCount' = blockedCount,
    notApplicableCount' = notApplicableCount
  }

  action step = any {
    blockPendingTask,
    dispatchReadyTask,
    completeRunningTask,
    doneStutter
  }

  // ---- Safety Invariants ----

  // 1. Concurrency bound
  val inv_job_limit: bool =
    runningTasks(statuses).size() <= JOB_LIMIT

  // 2. No task runs or finishes unless every dependency already succeeded
  val inv_prereq_order: bool =
    ALL_TASKS.forall(t =>
      (statuses.get(t) == "running" or statuses.get(t) == "executed" or statuses.get(t) == "failed")
        implies depsOf(t).forall(d => statuses.get(d) == "executed")
    )

  // 3. Unselected tasks never execute
  val inv_unselected_stay_na: bool =
    ALL_TASKS.forall(t =>
      not(selectedTasks.contains(t)) implies statuses.get(t) == "not_applicable"
    )

  // 4. No deadlock: if any task is still pending and no worker is running,
  //    at least one pending task must be either ready or blockable!
  val inv_no_deadlock: bool =
    (ALL_TASKS.exists(t => statuses.get(t) == "pending") and runningTasks(statuses).size() == 0)
      implies ALL_TASKS.exists(t =>
        statuses.get(t) == "pending" and
        (depState(t, statuses) == "ready" or depState(t, statuses) == "blocked")
      )

  // 5. Tally consistency at all times and exit code soundness at termination
  val inv_tally_and_exit_sound: bool = {
    val done = ALL_TASKS.forall(t => isTerminal(statuses.get(t)))
    val exitCode = if (failedCount > 0 or blockedCount > 0) 1 else 0
    executedCount == ALL_TASKS.filter(t => statuses.get(t) == "executed" or statuses.get(t) == "failed").size() and
    failedCount == ALL_TASKS.filter(t => statuses.get(t) == "failed").size() and
    blockedCount == ALL_TASKS.filter(t => statuses.get(t) == "blocked").size() and
    notApplicableCount == ALL_TASKS.filter(t => statuses.get(t) == "not_applicable").size() and
    (done implies (
      (exitCode == 0) == selectedTasks.forall(t => statuses.get(t) == "executed")
    ))
  }

  val all_invariants: bool =
    inv_job_limit and
    inv_prereq_order and
    inv_unselected_stay_na and
    inv_no_deadlock and
    inv_tally_and_exit_sound
}
