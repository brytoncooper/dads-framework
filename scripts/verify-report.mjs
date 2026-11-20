/**
 * What a `npm run verify` run says while it runs and when it ends.
 *
 * Live lines are in the order the events happen, so a reader can follow the
 * schedule. A failing step prints everything it wrote, delimited, the moment
 * it fails: a failure that has to be reproduced to be read is a failure that
 * costs a second run. The closing block is the table of every step, the
 * longest chain of steps through the graph, the budget receipt, and the wall
 * clock.
 */

import { topologicalOrder } from "./verify-graph.mjs";

const STATUS_LABEL = Object.freeze({
  passed: "ok",
  failed: "FAILED",
  blocked: "blocked",
  "not-run": "not run",
});

/** `12.34s`, so a column of durations lines up. */
export function formatDuration(milliseconds) {
  return `${(milliseconds / 1000).toFixed(2)}s`;
}

export function startLine(step) {
  return `  ->  ${step.id}`;
}

/** `cached` for a step skipped whole; the step's own note when it was partly. */
function cacheSuffix(result) {
  if (result.cache === null || result.cache === undefined) return "";
  return result.cache === "hit" ? "" : ` (${result.cache})`;
}

function statusLabel(result) {
  if (result.status === "passed" && result.cache === "hit") return "cached";
  return STATUS_LABEL[result.status] ?? result.status;
}

export function finishLine(result) {
  const label = statusLabel(result);
  const duration = formatDuration(result.durationMs);
  const code =
    result.status === "failed" ? ` (exit ${String(result.exitCode)})` : "";
  return `  ${label === "ok" ? "ok " : label} ${result.step.id} ${duration}${code}${cacheSuffix(result)}`;
}

export function blockedLine(result) {
  return `  blocked ${result.step.id} — ${result.blockedBy} did not pass`;
}

/** The failing step's whole stdout and stderr, fenced so it reads as one. */
export function failureBlock(result) {
  const rule = "-".repeat(72);
  const body = result.output.endsWith("\n")
    ? result.output
    : `${result.output}\n`;
  return [
    rule,
    `${result.step.id} failed with exit ${String(result.exitCode)}: ${commandOf(result.step)}`,
    rule,
    body.trimEnd(),
    rule,
    "",
  ].join("\n");
}

function commandOf(step) {
  return [step.command, ...step.args].join(" ");
}

/** One row per step, in the order the graph declares them. */
export function resultTable(results) {
  const width = Math.max(...results.map((result) => result.step.id.length));
  const rows = results.map((result) =>
    [
      `  ${result.step.id.padEnd(width)}`,
      formatDuration(result.durationMs).padStart(8),
      `${statusLabel(result)}${cacheSuffix(result)}`,
    ].join("  "),
  );
  return rows.join("\n");
}

/**
 * The longest chain of steps that had to happen one after another, measured.
 * It is the floor under the wall clock: no budget makes a run shorter.
 */
export function criticalPath(results) {
  const byId = new Map(results.map((result) => [result.step.id, result]));
  const best = new Map();
  for (const step of topologicalOrder(results.map((result) => result.step))) {
    const result = byId.get(step.id);
    const longest = longestNeed(step, best);
    best.set(step.id, {
      total: longest.total + (result?.durationMs ?? 0),
      chain: [...longest.chain, step.id],
    });
  }
  return [...best.values()].reduce(
    (longest, candidate) =>
      candidate.total > longest.total ? candidate : longest,
    { total: 0, chain: [] },
  );
}

function longestNeed(step, best) {
  return step.needs.reduce(
    (longest, need) => {
      const candidate = best.get(need) ?? { total: 0, chain: [] };
      return candidate.total > longest.total ? candidate : longest;
    },
    { total: 0, chain: [] },
  );
}

/** The closing block: table, critical path, receipt, wall clock. */
/** Which steps the local cache skipped, or why there was no cache. */
function cacheSentence(results, cacheState) {
  if (cacheState === undefined) return [];
  if (!cacheState.enabled) return [`  cache off: ${cacheState.reason}`];
  const hits = results.filter((result) => result.cache === "hit");
  const partial = results.filter(
    (result) =>
      result.cache !== null &&
      result.cache !== undefined &&
      result.cache !== "hit",
  );
  const names = hits.map((result) => result.step.id).join(", ") || "none";
  const lines = [
    `  cached ${String(hits.length)} of ${String(results.length)} steps: ${names}`,
  ];
  for (const result of partial)
    lines.push(`  partly cached: ${result.step.id} (${result.cache})`);
  if (cacheState.note !== "") lines.push(`  cache: ${cacheState.note}`);
  return lines;
}

export function summaryBlock({ results, wallMs, receipt, budget, cacheState }) {
  const path = criticalPath(results);
  const failures = results.filter((result) => result.status === "failed");
  return [
    "",
    resultTable(results),
    "",
    `  critical path  ${formatDuration(path.total)}  ${path.chain.join(" -> ")}`,
    `  ${receipt}`,
    `  ${results.length} steps, ${budget.jobs} at a time at most, wall clock ${formatDuration(wallMs)}`,
    ...cacheSentence(results, cacheState),
    failureSentence(failures, results),
    "",
  ].join("\n");
}

function failureSentence(failures, results) {
  if (failures.length === 0) return "  verify passed";
  const blocked = results.filter(
    (result) => result.status === "blocked",
  ).length;
  const names = failures.map((result) => result.step.id).join(", ");
  const tail = blocked === 0 ? "" : `, ${blocked} blocked behind them`;
  return `  verify failed: ${names}${tail}`;
}
