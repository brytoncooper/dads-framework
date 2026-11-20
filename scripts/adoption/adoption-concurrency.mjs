/**
 * How much of the machine the adoption proofs are allowed to use, and the pool
 * that spends it.
 *
 * Nothing here caches, skips, or reuses anything: every pack, install, import
 * and program still runs on every run. The only lever is how many of them run
 * at the same time. The budget is measured rather than guessed — idle cores
 * now, memory available now — so a busy laptop takes a small number and an
 * idle workstation takes a large one, and `DADS_ADOPTION_JOBS` overrides both
 * for a runner that knows better than the probe.
 */

import { availableParallelism, cpus, freemem } from "node:os";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { setTimeout as wait } from "node:timers/promises";

const MEBIBYTE = 1024 ** 2;
const GIBIBYTE = 1024 ** 3;
const MEMORY_HELD_BACK_BYTES = GIBIBYTE;
const MEMORY_PER_JOB_BYTES = 768 * MEBIBYTE;
const CPU_SAMPLE_MS = 250;

export async function chooseAdoptionJobs(requested, taskCount) {
  const explicit = parseRequestedJobs(requested);
  validateTaskCount(taskCount);
  if (explicit !== null || taskCount === 0) {
    return adoptionJobsFromResources(requested, taskCount, null);
  }
  return adoptionJobsFromResources(
    requested,
    taskCount,
    await sampleResources(),
  );
}

export function adoptionJobsFromResources(requested, taskCount, resources) {
  const explicit = parseRequestedJobs(requested);
  validateTaskCount(taskCount);
  const receipt = {
    mode: explicit === null ? "auto" : "explicit",
    jobs: 0,
    taskCount,
    resources: explicit === null ? resources : null,
    cpuBudget: null,
    memoryBudget: null,
    limitingReasons: [],
  };
  if (taskCount === 0) {
    receipt.limitingReasons.push("no-tasks");
    return receipt;
  }
  if (explicit !== null) {
    receipt.jobs = Math.min(explicit, taskCount);
    receipt.limitingReasons.push("explicit-override");
    if (taskCount < explicit) receipt.limitingReasons.push("task-count");
    return receipt;
  }
  return budgetFromResources(receipt, taskCount, resources);
}

/**
 * Run every task, at most `jobs` at a time, and report all of them.
 *
 * Tasks start longest first — `task.cost` is a rough measured second count,
 * and a long task started last is a tail the whole run waits behind. Reporting
 * ignores that entirely: results keep the order the tasks were declared in, and
 * the first failure in that declared order — not the first to happen — is the
 * one that owns the exit code, so two identical runs blame the same task.
 *
 * A failure stops new tasks from starting but never truncates the report; the
 * tasks already in flight are awaited and the caller decides what to print.
 */
export async function runTaskPool(tasks, jobs) {
  if (!Number.isSafeInteger(jobs) || jobs < 1) {
    throw new Error("Job count must be a positive safe integer.");
  }
  const results = tasks.map((task) => ({
    name: task.name,
    status: "skipped",
    durationMs: 0,
    error: null,
  }));
  const startOrder = longestFirst(tasks);
  let nextPosition = 0;
  let stopped = false;
  const consume = async () => {
    while (!stopped && nextPosition < startOrder.length) {
      const index = startOrder[nextPosition];
      nextPosition += 1;
      const result = await settleTask(tasks[index], results[index]);
      if (result.status === "failed") stopped = true;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(jobs, tasks.length) }, consume),
  );
  return results;
}

function longestFirst(tasks) {
  return tasks
    .map((task, index) => ({ index, cost: taskCost(task) }))
    .sort((left, right) => right.cost - left.cost || left.index - right.index)
    .map((entry) => entry.index);
}

function taskCost(task) {
  if (task.cost === undefined) return 1;
  if (!Number.isFinite(task.cost) || task.cost <= 0) {
    throw new Error(
      `Task ${task.name} declared a cost that is not a positive number.`,
    );
  }
  return task.cost;
}

export function firstFailure(results) {
  return results.find((result) => result.status === "failed") ?? null;
}

async function settleTask(task, result) {
  const startedAt = performance.now();
  try {
    await task.run();
    result.status = "ok";
  } catch (error) {
    result.status = "failed";
    result.error = error;
  }
  result.durationMs = Math.round(performance.now() - startedAt);
  return result;
}

function budgetFromResources(receipt, taskCount, resources) {
  if (!validResources(resources)) {
    receipt.jobs = 1;
    receipt.limitingReasons.push("resource-probe-unavailable");
    return receipt;
  }
  receipt.cpuBudget = Math.max(
    1,
    Math.floor(resources.cpuCapacity * resources.cpuIdleFraction) - 1,
  );
  receipt.memoryBudget = Math.floor(
    Math.max(0, resources.availableMemoryBytes - MEMORY_HELD_BACK_BYTES) /
      MEMORY_PER_JOB_BYTES,
  );
  const limit = Math.min(taskCount, receipt.cpuBudget, receipt.memoryBudget);
  receipt.jobs = Math.max(1, limit);
  if (receipt.cpuBudget === limit) receipt.limitingReasons.push("cpu-budget");
  if (receipt.memoryBudget === limit)
    receipt.limitingReasons.push("memory-budget");
  if (taskCount === limit) receipt.limitingReasons.push("task-count");
  if (limit < 1) receipt.limitingReasons.push("minimum-one-job");
  return receipt;
}

function parseRequestedJobs(requested) {
  if (requested === undefined || requested === "" || requested === "auto") {
    return null;
  }
  if (
    typeof requested !== "string" ||
    !/^[1-9]\d*$/.test(requested) ||
    !Number.isSafeInteger(Number(requested))
  ) {
    throw new Error(
      `DADS_ADOPTION_JOBS must be auto or a positive integer, received ${JSON.stringify(requested)}.`,
    );
  }
  return Number(requested);
}

function validateTaskCount(taskCount) {
  if (!Number.isSafeInteger(taskCount) || taskCount < 0) {
    throw new Error("Task count must be a nonnegative safe integer.");
  }
}

function validResources(resources) {
  return (
    resources !== null &&
    typeof resources === "object" &&
    Number.isSafeInteger(resources.cpuCapacity) &&
    resources.cpuCapacity > 0 &&
    Number.isFinite(resources.cpuIdleFraction) &&
    resources.cpuIdleFraction >= 0 &&
    resources.cpuIdleFraction <= 1 &&
    Number.isFinite(resources.availableMemoryBytes) &&
    resources.availableMemoryBytes >= 0 &&
    Array.isArray(resources.probeErrors) &&
    resources.probeErrors.length === 0
  );
}

async function sampleResources() {
  const resources = {
    cpuCapacity: null,
    cpuIdleFraction: null,
    availableMemoryBytes: null,
    probeErrors: [],
  };
  await sampleCpu(resources);
  sampleMemory(resources);
  if (!validResources(resources) && resources.probeErrors.length === 0) {
    resources.probeErrors.push(
      "Resource sample has missing or invalid readings.",
    );
  }
  return resources;
}

async function sampleCpu(resources) {
  try {
    resources.cpuCapacity = availableParallelism();
    const before = cpuTotals();
    await wait(CPU_SAMPLE_MS);
    resources.cpuIdleFraction = idleFraction(before, cpuTotals());
  } catch (error) {
    resources.probeErrors.push(`CPU probe: ${errorMessage(error)}`);
  }
}

function sampleMemory(resources) {
  try {
    resources.availableMemoryBytes =
      typeof process.availableMemory === "function"
        ? process.availableMemory()
        : freemem();
  } catch (error) {
    resources.probeErrors.push(`Memory probe: ${errorMessage(error)}`);
  }
}

function idleFraction(before, after) {
  if (before.length !== after.length || before.length === 0) {
    throw new Error("CPU sample inventory changed or is empty.");
  }
  let idleDelta = 0;
  let totalDelta = 0;
  for (const [index, sample] of before.entries()) {
    const idle = after[index].idle - sample.idle;
    const total = after[index].total - sample.total;
    if (!Number.isFinite(idle) || idle < 0 || total <= 0 || idle > total) {
      throw new Error("CPU time sample has invalid deltas.");
    }
    idleDelta += idle;
    totalDelta += total;
  }
  return idleDelta / totalDelta;
}

function cpuTotals() {
  return cpus().map(({ times }) => ({
    idle: times.idle,
    total: times.user + times.nice + times.sys + times.idle + times.irq,
  }));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
