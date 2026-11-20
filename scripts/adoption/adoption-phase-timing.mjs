/**
 * Wall-clock accounting for the adoption proofs.
 *
 * A phase runs many times, and once the proofs run concurrently several of its
 * runs overlap, so one number cannot describe it. Both are kept: `totalMs` adds
 * every run together (what the machine spent) and `spanMs` measures the first
 * start to the last end (what the clock saw). Serial work has them equal;
 * concurrent work does not, and the gap is exactly what concurrency bought.
 */

import { performance } from "node:perf_hooks";

export function createPhaseTimer(now = () => performance.now()) {
  const phases = new Map();
  const timer = {
    start(phase) {
      const startedAt = now();
      const record = openPhase(phases, phase, startedAt);
      let closed = false;
      return () => {
        if (closed) throw new Error(`Phase ${phase} was closed twice.`);
        closed = true;
        closePhase(record, startedAt, now());
      };
    },
    async time(phase, run) {
      const end = timer.start(phase);
      try {
        return await run();
      } finally {
        end();
      }
    },
    report() {
      return [...phases.values()].map(reportPhase);
    },
    formatTable(title) {
      return formatPhaseTable(title, timer.report());
    },
  };
  return timer;
}

export function formatPhaseTable(title, report) {
  const rows = [
    ["phase", "runs", "total s", "wall s"],
    ...report.map((entry) => [
      entry.phase,
      String(entry.runs),
      seconds(entry.totalMs),
      seconds(entry.spanMs),
    ]),
  ];
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => row[column].length)),
  );
  const lines = rows.map((row) =>
    row.map((cell, column) => pad(cell, widths[column], column)).join("  "),
  );
  lines.splice(1, 0, widths.map((width) => "-".repeat(width)).join("  "));
  return [`${title}:`, ...lines.map((line) => `  ${line}`)].join("\n");
}

function openPhase(phases, phase, startedAt) {
  if (typeof phase !== "string" || phase.length === 0) {
    throw new Error("A phase name must be a non-empty string.");
  }
  const existing = phases.get(phase);
  if (existing) {
    existing.open += 1;
    return existing;
  }
  const record = {
    phase,
    runs: 0,
    open: 1,
    totalMs: 0,
    firstStartedAt: startedAt,
    lastEndedAt: startedAt,
  };
  phases.set(phase, record);
  return record;
}

function closePhase(record, startedAt, endedAt) {
  record.open -= 1;
  record.runs += 1;
  record.totalMs += endedAt - startedAt;
  record.lastEndedAt = Math.max(record.lastEndedAt, endedAt);
}

function reportPhase(record) {
  if (record.open !== 0) {
    throw new Error(`Phase ${record.phase} is still running.`);
  }
  return {
    phase: record.phase,
    runs: record.runs,
    totalMs: Math.round(record.totalMs),
    spanMs: Math.round(record.lastEndedAt - record.firstStartedAt),
  };
}

function seconds(milliseconds) {
  return (milliseconds / 1000).toFixed(1);
}

function pad(cell, width, column) {
  return column === 0 ? cell.padEnd(width) : cell.padStart(width);
}
