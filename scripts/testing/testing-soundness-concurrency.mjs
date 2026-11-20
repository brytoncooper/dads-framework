import { availableParallelism, cpus, freemem } from "node:os";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { setTimeout } from "node:timers/promises";

const GIBIBYTE = 1024 ** 3;
const SAMPLE_MS = 250;

/**
 * Chooses how much of the machine one corpus run may use.
 *
 * A task is one mostly single-threaded tool process, so the CPU budget is the
 * total number of task processes a run may keep alive at once: the idle
 * capacity minus one slot for the harness itself. That budget is spent twice
 * over. Inside a case, `taskJobs` tasks run at once, capped by the width of the
 * task graph because no scheduler can start more work than that. Across cases,
 * `caseJobs` is what is left of the budget once each case has taken its tasks,
 * and it is capped again by available memory and by the number of cases.
 *
 * `taskGraphWidth` is the widest set of tasks that can ever be in flight, from
 * `taskGraphWidth()` in `testing-soundness-execution.mjs`. An explicit
 * `requested` case count keeps its literal meaning: one task at a time per
 * case, so the run holds exactly that many task processes.
 */
export async function chooseCaseConcurrency(
  requested,
  caseCount,
  taskGraphWidth = 1,
) {
  const explicit = parseRequested(requested);
  validateCaseCount(caseCount);
  validateTaskGraphWidth(taskGraphWidth);
  if (explicit !== null || caseCount === 0) {
    return caseConcurrencyFromResources(
      requested,
      caseCount,
      null,
      taskGraphWidth,
    );
  }
  return caseConcurrencyFromResources(
    requested,
    caseCount,
    await sampleResources(),
    taskGraphWidth,
  );
}

/** The pure half of `chooseCaseConcurrency`, given an already sampled host. */
export function caseConcurrencyFromResources(
  requested,
  caseCount,
  resources,
  taskGraphWidth = 1,
) {
  const explicit = parseRequested(requested);
  validateCaseCount(caseCount);
  validateTaskGraphWidth(taskGraphWidth);
  const receipt = {
    mode: explicit === null ? "auto" : "explicit",
    caseJobs: 0,
    taskJobs: 1,
    taskGraphWidth,
    resources: explicit === null ? resources : null,
    cpuBudget: null,
    memoryBudget: null,
    limitingReasons: [],
    nativeJobs: 1,
    vitestMaxWorkers: 1,
  };
  if (caseCount === 0) {
    receipt.limitingReasons.push("empty-corpus");
    return receipt;
  }
  if (explicit !== null) return explicitBudget(receipt, explicit, caseCount);
  if (!validResources(resources)) {
    receipt.caseJobs = 1;
    receipt.limitingReasons.push("resource-probe-unavailable");
    return receipt;
  }
  return sampledBudget(receipt, caseCount, resources);
}

function explicitBudget(receipt, explicit, caseCount) {
  receipt.caseJobs = Math.min(explicit, caseCount);
  receipt.limitingReasons.push("explicit-override");
  if (caseCount < explicit) receipt.limitingReasons.push("case-count");
  return receipt;
}

function sampledBudget(receipt, caseCount, resources) {
  receipt.cpuBudget = Math.max(
    1,
    Math.floor(resources.cpuCapacity * resources.cpuIdleFraction - 1),
  );
  receipt.memoryBudget = Math.floor(
    Math.max(0, resources.availableMemoryBytes - GIBIBYTE) / GIBIBYTE,
  );
  receipt.taskJobs = Math.min(receipt.cpuBudget, receipt.taskGraphWidth);
  receipt.nativeJobs = receipt.taskJobs;
  // Rounded, not floored: on a wide machine the remainder of the budget is
  // worth more as one more case, half a case's tasks over the budget, than as
  // idle cores; the budget already keeps one core in reserve.
  const cpuCaseLimit = Math.max(
    1,
    Math.round(receipt.cpuBudget / receipt.taskJobs),
  );
  const limit = Math.min(caseCount, cpuCaseLimit, receipt.memoryBudget);
  receipt.caseJobs = Math.max(1, limit);
  recordLimitingReasons(receipt, caseCount, cpuCaseLimit, limit);
  return receipt;
}

function recordLimitingReasons(receipt, caseCount, cpuCaseLimit, limit) {
  if (cpuCaseLimit === limit) receipt.limitingReasons.push("cpu-budget");
  if (receipt.memoryBudget === limit)
    receipt.limitingReasons.push("memory-budget");
  if (caseCount === limit) receipt.limitingReasons.push("case-count");
  if (receipt.taskJobs === receipt.taskGraphWidth)
    receipt.limitingReasons.push("task-graph-width");
  if (limit < 1) receipt.limitingReasons.push("minimum-one-case");
}

export async function orderedConcurrentMap(items, limit, worker) {
  if (items.length === 0) return [];
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Concurrency limit must be a positive safe integer.");
  }
  const results = new Array(items.length);
  let nextIndex = 0;
  let failed = false;
  let firstError;
  async function consume() {
    while (!failed && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, consume),
  );
  if (failed) throw firstError;
  return results;
}

function parseRequested(requested) {
  if (requested === undefined || requested === "auto") return null;
  if (
    typeof requested !== "string" ||
    !/^[1-9]\d*$/.test(requested) ||
    !Number.isSafeInteger(Number(requested))
  ) {
    throw new Error(
      "Case jobs must be auto or a positive safe integer string.",
    );
  }
  return Number(requested);
}

function validateCaseCount(caseCount) {
  if (!Number.isSafeInteger(caseCount) || caseCount < 0) {
    throw new Error("Invalid case count: expected a nonnegative safe integer.");
  }
}

function validateTaskGraphWidth(taskGraphWidth) {
  if (!Number.isSafeInteger(taskGraphWidth) || taskGraphWidth < 1) {
    throw new Error(
      "Invalid task graph width: expected a positive safe integer.",
    );
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
    Number.isFinite(resources.sampleDurationMs) &&
    resources.sampleDurationMs > 0 &&
    Array.isArray(resources.probeErrors) &&
    resources.probeErrors.length === 0
  );
}

export async function sampleResources() {
  const resources = {
    cpuCapacity: null,
    cpuIdleFraction: null,
    availableMemoryBytes: null,
    sampleDurationMs: null,
    probeErrors: [],
  };
  try {
    resources.cpuCapacity = availableParallelism();
    const before = cpuTotals();
    const started = performance.now();
    await setTimeout(SAMPLE_MS);
    const after = cpuTotals();
    resources.sampleDurationMs = performance.now() - started;
    if (before.length !== after.length || before.length === 0) {
      throw new Error("CPU sample inventory changed or is empty.");
    }
    let idleDelta = 0;
    let totalDelta = 0;
    for (let index = 0; index < before.length; index += 1) {
      const idle = after[index].idle - before[index].idle;
      const total = after[index].total - before[index].total;
      if (
        !Number.isFinite(idle) ||
        !Number.isFinite(total) ||
        idle < 0 ||
        total <= 0 ||
        idle > total
      ) {
        throw new Error("CPU time sample has invalid deltas.");
      }
      idleDelta += idle;
      totalDelta += total;
    }
    resources.cpuIdleFraction = idleDelta / totalDelta;
  } catch (error) {
    resources.probeErrors.push(`CPU probe: ${errorMessage(error)}`);
  }
  try {
    resources.availableMemoryBytes =
      typeof process.availableMemory === "function"
        ? process.availableMemory()
        : freemem();
  } catch (error) {
    resources.probeErrors.push(`Memory probe: ${errorMessage(error)}`);
  }
  if (!validResources(resources) && resources.probeErrors.length === 0) {
    resources.probeErrors.push(
      "Resource sample contains missing or invalid readings.",
    );
  }
  return resources;
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
