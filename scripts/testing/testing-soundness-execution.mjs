import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { clearTimeout, setTimeout } from "node:timers";

const OUTPUT_LIMIT = 8_192;
const TASK_TIMEOUT_MS = 60_000;

export function loadTaskManifest(path) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0)
    throw new Error("Soundness manifest must declare tasks.");
  const ids = new Set();
  for (const task of manifest.tasks) {
    if (
      typeof task?.id !== "string" ||
      typeof task.execution?.executable !== "string" ||
      !Array.isArray(task.execution.args) ||
      !Array.isArray(task.dependsOn)
    ) {
      throw new Error("Soundness manifest has an invalid task execution.");
    }
    if (ids.has(task.id))
      throw new Error(`Duplicate soundness task ${task.id}.`);
    ids.add(task.id);
  }
  return manifest;
}

export function stageWorkspaceTools(repositoryRoot, workspace) {
  const source = resolve(repositoryRoot, "node_modules");
  const target = join(workspace, "node_modules");
  if (!existsSync(source) || !lstatSync(source).isDirectory())
    throw new Error(`Installed tools are missing at ${source}.`);
  if (existsSync(target)) throw new Error(`Workspace already has ${target}.`);
  symlinkSync(source, target, "dir");
}

export function toolVersions(repositoryRoot) {
  return {
    node: process.version,
    eslint: packageVersion(repositoryRoot, "eslint"),
    oxlint: packageVersion(repositoryRoot, "oxlint"),
    typescript: packageVersion(repositoryRoot, "typescript"),
    typescriptNative: packageVersion(repositoryRoot, "typescript-native"),
    vitest: packageVersion(repositoryRoot, "vitest"),
  };
}

/**
 * The widest set of tasks that can ever be in flight at once: the largest
 * number of tasks sharing a longest-path depth in the `dependsOn` graph.
 *
 * It is the cap on the per-case task limit, because scheduling more processes
 * than this cannot start more work.
 */
export function taskGraphWidth(tasks) {
  const { dependencies } = taskSchedule(tasks);
  const depths = new Map();
  const tasksPerDepth = new Map();
  for (const task of tasks) {
    const depth = taskDepth(task.id, dependencies, depths);
    tasksPerDepth.set(depth, (tasksPerDepth.get(depth) ?? 0) + 1);
  }
  return Math.max(1, ...tasksPerDepth.values());
}

/**
 * Runs every task once and returns the outcomes in manifest order.
 *
 * A task starts once its `dependsOn` prerequisites have finished, up to
 * `taskJobs` tasks at a time. A failed prerequisite does not block its
 * dependents: the oracle needs every task's own outcome, so the graph only
 * orders the work, it never cancels it.
 */
export async function executeTasksIndependently(
  tasks,
  workspace,
  environment = {},
  taskJobs = 1,
) {
  const run = executionRun(tasks, workspace, environment, taskJobs);
  await Promise.all(tasks.map((task) => completeTask(run, task.id)));
  return run.results;
}

export function compareTaskOutcomes(baseline, mutated) {
  const baselineById = byTaskId(baseline, "baseline");
  const mutatedById = byTaskId(mutated, "mutated");
  if (baselineById.size !== mutatedById.size)
    throw new Error("Task inventories differ between baseline and mutation.");
  const changedTaskIds = [];
  for (const [id, baselineResult] of baselineById) {
    const mutatedResult = mutatedById.get(id);
    if (!mutatedResult) throw new Error(`Mutation did not observe task ${id}.`);
    if (normalizedOutcome(baselineResult) !== normalizedOutcome(mutatedResult))
      changedTaskIds.push(id);
  }
  return {
    changedTaskIds: stableIds(changedTaskIds),
    baseline: orderedOutcomes(baseline),
    mutated: orderedOutcomes(mutated),
  };
}

export function assertObservedTasks(tasks, outcomes, label) {
  const expected = stableIds(tasks.map((task) => task.id));
  const observed = stableIds(outcomes.map((outcome) => outcome.id));
  if (expected.join(",") !== observed.join(","))
    throw new Error(`${label} task inventory was incomplete.`);
  for (const outcome of outcomes) {
    if (outcome.status === "spawn-error" || outcome.status === "timed-out")
      throw new Error(`${label} task ${outcome.id} did not complete.`);
  }
}

export function assertValidBaseline(outcomes) {
  const invalid = outcomes.filter((outcome) => outcome.status !== "passed");
  if (invalid.length > 0)
    throw new Error(
      `Baseline tasks did not pass: ${invalid.map((outcome) => outcome.id).join(", ")}.`,
    );
}

export function normalizedOutcome(outcome) {
  return `${outcome.status}:${String(outcome.exitCode)}`;
}

function executionRun(tasks, workspace, environment, taskJobs) {
  if (!Number.isSafeInteger(taskJobs) || taskJobs < 1)
    throw new Error("Task jobs must be a positive safe integer.");
  const { byId, dependencies } = taskSchedule(tasks);
  return {
    byId,
    dependencies,
    workspace,
    environment,
    gate: createGate(taskJobs),
    positions: new Map(tasks.map((task, position) => [task.id, position])),
    started: new Map(),
    results: new Array(tasks.length),
  };
}

function completeTask(run, id) {
  const started = run.started.get(id);
  if (started !== undefined) return started;
  const completion = runWhenReady(run, id);
  run.started.set(id, completion);
  return completion;
}

async function runWhenReady(run, id) {
  const prerequisites = run.dependencies
    .get(id)
    .map((dependency) => completeTask(run, dependency));
  await Promise.all(prerequisites);
  await run.gate.acquire();
  try {
    run.results[run.positions.get(id)] = await executeTask(
      run.byId.get(id),
      run.workspace,
      run.environment,
    );
  } finally {
    run.gate.release();
  }
}

/** Task lookup plus deduplicated prerequisites, refusing an unrunnable graph. */
function taskSchedule(tasks) {
  const byId = new Map();
  for (const task of tasks) {
    if (byId.has(task.id))
      throw new Error(`Duplicate soundness task ${task.id}.`);
    byId.set(task.id, task);
  }
  const dependencies = new Map(
    tasks.map((task) => [task.id, [...new Set(task.dependsOn)]]),
  );
  for (const [id, prerequisites] of dependencies) {
    for (const prerequisite of prerequisites)
      if (!byId.has(prerequisite))
        throw new Error(`Task ${id} depends on unknown task ${prerequisite}.`);
  }
  assertAcyclic(dependencies);
  return { byId, dependencies };
}

function assertAcyclic(dependencies) {
  const remaining = new Map(
    [...dependencies].map(([id, prerequisites]) => [id, prerequisites.length]),
  );
  const dependents = new Map([...dependencies.keys()].map((id) => [id, []]));
  for (const [id, prerequisites] of dependencies)
    for (const prerequisite of prerequisites)
      dependents.get(prerequisite).push(id);
  const ready = [...remaining]
    .filter(([, count]) => count === 0)
    .map(([id]) => id);
  let settled = 0;
  while (ready.length > 0) {
    releaseDependents(ready.pop(), ready, dependents, remaining);
    settled += 1;
  }
  if (settled !== dependencies.size)
    throw new Error("Soundness task graph has a dependency cycle.");
}

function releaseDependents(id, ready, dependents, remaining) {
  for (const dependent of dependents.get(id)) {
    const count = remaining.get(dependent) - 1;
    remaining.set(dependent, count);
    if (count === 0) ready.push(dependent);
  }
}

function taskDepth(id, dependencies, depths) {
  const known = depths.get(id);
  if (known !== undefined) return known;
  let depth = 0;
  for (const prerequisite of dependencies.get(id))
    depth = Math.max(depth, taskDepth(prerequisite, dependencies, depths) + 1);
  depths.set(id, depth);
  return depth;
}

/** A counting semaphore: `limit` tasks hold a slot, the rest queue in order. */
function createGate(limit) {
  let available = limit;
  const waiting = [];
  return {
    async acquire() {
      if (available > 0) {
        available -= 1;
        return;
      }
      await new Promise((release) => waiting.push(release));
    },
    release() {
      const next = waiting.shift();
      if (next === undefined) available += 1;
      else next();
    },
  };
}

async function executeTask(task, workspace, environment) {
  const cwd = task.execution.cwd
    ? resolveInside(workspace, task.execution.cwd)
    : workspace;
  const startedAt = performance.now();
  return new Promise((resolvePromise) => {
    let settled = false;
    let timedOut = false;
    const stdout = captureChunks();
    const stderr = captureChunks();
    const child = spawn(task.execution.executable, task.execution.args, {
      cwd,
      env: {
        ...process.env,
        ...environment,
        VITE_CACHE_DIR: join(workspace, ".vite"),
        VITEST_CACHE_DIR: join(workspace, ".vitest"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise({
        id: task.id,
        durationMs: performance.now() - startedAt,
        stdout: stdout.result(),
        stderr: stderr.result(),
        ...result,
      });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, TASK_TIMEOUT_MS);
    const forceKill = setTimeout(() => {
      if (timedOut && !settled) {
        child.kill("SIGKILL");
        settle({ status: "timed-out", exitCode: null, error: "Timed out." });
      }
    }, TASK_TIMEOUT_MS + 1_000);
    const settleWithCleanup = (result) => {
      clearTimeout(forceKill);
      settle(result);
    };
    child.stdout.on("data", (chunk) => stdout.add(chunk));
    child.stderr.on("data", (chunk) => stderr.add(chunk));
    child.once("error", (error) =>
      settleWithCleanup({
        status: "spawn-error",
        exitCode: null,
        error: error.message,
      }),
    );
    child.once("close", (exitCode) => {
      if (timedOut) {
        settleWithCleanup({
          status: "timed-out",
          exitCode: null,
          error: "Timed out.",
        });
        return;
      }
      if (!Number.isInteger(exitCode)) {
        settleWithCleanup({
          status: "spawn-error",
          exitCode: null,
          error: "No exit code.",
        });
        return;
      }
      settleWithCleanup({
        status: exitCode === 0 ? "passed" : "failed",
        exitCode,
        error: null,
      });
    });
  });
}

function packageVersion(repositoryRoot, packageName) {
  const path = resolve(
    repositoryRoot,
    "node_modules",
    packageName,
    "package.json",
  );
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value.version !== "string")
    throw new Error(`Tool ${packageName} has no version.`);
  return value.version;
}

function resolveInside(root, candidate) {
  const resolved = resolve(root, candidate);
  if (resolved !== root && !resolved.startsWith(`${root}/`))
    throw new Error(`Task cwd escapes fixture workspace: ${candidate}`);
  return resolved;
}

function byTaskId(outcomes, label) {
  const result = new Map();
  for (const outcome of outcomes) {
    if (result.has(outcome.id))
      throw new Error(`Duplicate ${label} task ${outcome.id}.`);
    result.set(outcome.id, outcome);
  }
  return result;
}

function orderedOutcomes(outcomes) {
  return [...outcomes]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((outcome) => ({
      id: outcome.id,
      durationMs: outcome.durationMs,
      status: outcome.status,
      exitCode: outcome.exitCode,
      diagnostics: {
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        error: outcome.error,
      },
    }));
}

function captureChunks() {
  let text = "";
  let truncated = false;
  return {
    add(chunk) {
      if (truncated) return;
      const value = String(chunk);
      const remaining = OUTPUT_LIMIT - text.length;
      if (value.length > remaining) {
        text += value.slice(0, remaining);
        truncated = true;
        return;
      }
      text += value;
    },
    result() {
      return { text, truncated };
    },
  };
}

function stableIds(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
