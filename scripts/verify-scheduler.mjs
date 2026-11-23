/**
 * Runs a step graph as wide as a slot budget allows.
 *
 * Two rules decide what may run together. A step's weight is the slots it
 * keeps busy, and the sum of the running weights stays inside the budget. A
 * step weighted `"all"` owns a worker pool of its own, so it counts as the
 * whole budget against another `"all"` step — two never run together — and as
 * half of it against the single-threaded checks, which is what it measured:
 * Vitest kept 4.7 of 15 cores busy, `tsc -b` kept 1.9. Booking half leaves the
 * cheap checks draining beside it instead of queued behind it.
 *
 * A step always starts when nothing else is running, so a graph still runs on
 * a one-slot budget and a step heavier than the whole machine still runs.
 *
 * Failure does not stop work already in flight. It blocks the steps that read
 * that step's output, and nothing else, unless `failFast` is set — then no
 * further step is started at all.
 */

import { performance } from "node:perf_hooks";
import { topologicalOrder, transitiveDependentCount } from "./verify-graph.mjs";

/** The slots one step books against a budget. */
export function slotsFor(step, budget) {
  if (step.weight === "all") return Math.max(1, Math.ceil(budget / 2));
  if (!Number.isSafeInteger(step.weight) || step.weight < 1) {
    throw new Error(
      `Step "${step.id}" declares weight ${String(step.weight)}; expected a positive whole number or "all".`,
    );
  }
  return step.weight;
}

/** Runs every step it can, and reports what happened to all of them. */
export async function runVerifyGraph(options) {
  const context = createContext(options);
  const startedAt = performance.now();
  while (true) {
    blockDependentsOfFailures(context);
    startWhatFits(context);
    if (context.running.size === 0) break;
    await Promise.race(context.running.values());
  }
  abandonRemaining(context);
  return summarize(context, performance.now() - startedAt);
}

function createContext(options) {
  const { steps, budget, runStep } = options;
  if (!Number.isSafeInteger(budget) || budget < 1) {
    throw new Error(`Budget must be a positive whole number, not ${String(budget)}.`);
  }
  const serial = options.serial === true;
  return {
    steps,
    budget,
    serial,
    failFast: options.failFast === true,
    runStep,
    onEvent: options.onEvent ?? (() => undefined),
    ordered: topologicalOrder(steps),
    queue: serial ? [...steps] : prioritized(steps),
    pending: new Map(steps.map((step) => [step.id, step])),
    running: new Map(),
    results: new Map(),
    weightInFlight: 0,
    allInFlight: 0,
    firstFailure: null,
  };
}

/**
 * Ready steps are considered widest-first: the step that unblocks the most
 * other work goes in before a leaf that only occupies a slot.
 */
function prioritized(steps) {
  const unblocks = transitiveDependentCount(steps);
  const declared = new Map(steps.map((step, index) => [step.id, index]));
  return [...steps].sort((left, right) => {
    const byUnblocks = (unblocks.get(right.id) ?? 0) - (unblocks.get(left.id) ?? 0);
    if (byUnblocks !== 0) return byUnblocks;
    return (declared.get(left.id) ?? 0) - (declared.get(right.id) ?? 0);
  });
}

function startWhatFits(context) {
  if (context.failFast && context.firstFailure !== null) return;
  for (const step of context.queue) {
    if (!context.pending.has(step.id)) continue;
    if (!dependenciesPassed(step, context)) continue;
    if (!canStart(step, context)) continue;
    launch(step, context);
  }
}

function dependenciesPassed(step, context) {
  return step.needs.every((need) => context.results.get(need)?.status === "passed");
}

function canStart(step, context) {
  if (context.running.size === 0) return true;
  if (step.weight === "all" && context.allInFlight > 0) return false;
  return context.weightInFlight + slotsFor(step, context.budget) <= context.budget;
}

function launch(step, context) {
  context.pending.delete(step.id);
  context.weightInFlight += slotsFor(step, context.budget);
  if (step.weight === "all") context.allInFlight += 1;
  context.running.set(step.id, runOne(step, context));
}

async function runOne(step, context) {
  const startedAt = performance.now();
  context.onEvent({ type: "start", step });
  const outcome = await attempt(step, context);
  const result = {
    step,
    status: outcome.exitCode === 0 ? "passed" : "failed",
    exitCode: outcome.exitCode,
    output: outcome.output,
    durationMs: performance.now() - startedAt,
    cache: outcome.cache ?? null,
  };
  release(step, context);
  record(result, context);
  return step.id;
}

async function attempt(step, context) {
  try {
    return await context.runStep(step);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 1,
      output: `${step.id} could not be started: ${message}\n`,
    };
  }
}

function release(step, context) {
  context.running.delete(step.id);
  context.weightInFlight -= slotsFor(step, context.budget);
  if (step.weight === "all") context.allInFlight -= 1;
}

function record(result, context) {
  context.results.set(result.step.id, result);
  if (result.status === "failed" && context.firstFailure === null) {
    context.firstFailure = result;
  }
  context.onEvent({ type: "finish", ...result });
}

/** A step whose input never arrived is blocked, in dependency order. */
function blockDependentsOfFailures(context) {
  for (const step of context.ordered) {
    if (!context.pending.has(step.id)) continue;
    const blocker = step.needs.find((need) => notPassed(context.results.get(need)));
    if (blocker === undefined) continue;
    context.pending.delete(step.id);
    const result = {
      step,
      status: "blocked",
      exitCode: null,
      output: "",
      durationMs: 0,
      blockedBy: blocker,
    };
    context.results.set(step.id, result);
    context.onEvent({ type: "blocked", ...result });
  }
}

function notPassed(result) {
  return result !== undefined && result.status !== "passed";
}

function abandonRemaining(context) {
  const stoppedEarly = context.failFast && context.firstFailure !== null;
  if (context.pending.size > 0 && !stoppedEarly) {
    throw new Error(
      `Verify scheduler stalled with nothing running and ${context.pending.size} step(s) waiting: ${[...context.pending.keys()].join(", ")}.`,
    );
  }
  for (const step of context.pending.values()) {
    context.results.set(step.id, {
      step,
      status: "not-run",
      exitCode: null,
      output: "",
      durationMs: 0,
    });
  }
  context.pending.clear();
}

function summarize(context, wallMs) {
  const results = context.steps.map((step) => {
    const result = context.results.get(step.id);
    if (result === undefined) {
      throw new Error(`Verify step "${step.id}" produced no result.`);
    }
    return result;
  });
  return {
    results,
    wallMs,
    exitCode: context.firstFailure === null ? 0 : (context.firstFailure.exitCode ?? 1),
  };
}
