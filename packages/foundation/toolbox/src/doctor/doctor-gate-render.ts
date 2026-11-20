/**
 * What a gate run says: one line per finding, one summary, and the same
 * outcome as an object on `--json`.
 *
 * The wording is the wording the source-budget ratchet used before the doctor
 * owned it, because the audience did not change: a pre-commit hook printing the
 * one file it refused, an agent guard repeating the twenty lines that matter,
 * and a CI job whose log is read by whoever the ratchet just stopped. Every
 * line names the section, the key, the number, and what to do about it.
 */

import {
  compareStrings,
  countEntries,
  type GateBaseline,
  type GateFinding,
  type GateInventoryRow,
  type GateMode,
} from "./doctor-gate-model.js";

export type GateSummary = {
  readonly listed: number;
  readonly errors: number;
  readonly warnings: number;
  readonly overCeiling: number;
};

export type GateOutcome = {
  readonly mode: GateMode;
  readonly baseline: GateBaseline;
  readonly findings: readonly GateFinding[];
  readonly notes: readonly string[];
  readonly inventory: readonly GateInventoryRow[];
};

/** The name a run answers to, which is the mode it was asked for. */
export function gateModeName(mode: GateMode): string {
  if (mode.seed) return "seed";
  if (mode.base !== undefined) return "base";
  if (mode.report) return "report";
  return mode.update ? "update" : "check";
}

export function summarizeGate(outcome: GateOutcome): GateSummary {
  return {
    listed:
      countEntries(outcome.baseline.ceilings) +
      countEntries(outcome.baseline.floors),
    errors: outcome.findings.filter((item) => item.level === "error").length,
    warnings: outcome.findings.filter((item) => item.level === "warning")
      .length,
    overCeiling: outcome.inventory
      .filter(
        (row) =>
          row.direction === "ceiling" && row.value > (row.threshold ?? 0),
      )
      .reduce((total, row) => total + row.value - (row.threshold ?? 0), 0),
  };
}

function describeFinding(item: GateFinding): string {
  const subject = [item.measure, item.key].filter(Boolean).join(" ");
  return subject.length > 0
    ? `${item.level}: ${subject}: ${item.message}`
    : `${item.level}: ${item.message}`;
}

/** Every listed or over-threshold key, largest first. */
function renderInventory(
  inventory: readonly GateInventoryRow[],
): readonly string[] {
  return inventory
    .filter(
      (row) =>
        row.mark !== undefined ||
        (row.direction === "ceiling" && row.value > (row.threshold ?? 0)),
    )
    .sort(
      (left, right) =>
        right.value - left.value || compareStrings(left.key, right.key),
    )
    .map(
      (row) =>
        `${row.measure} ${row.key}: ${row.value} ${row.unit} (mark ${row.mark ?? "none"}, ${row.direction} ${row.threshold ?? "current"}${describeMove(row)})`,
    );
}

/** The receipt a floor entry carries, where it carries one. */
function describeMove(row: GateInventoryRow): string {
  return row.movedTo === undefined ? "" : `, moved to ${row.movedTo}`;
}

/** The human lines, in the order a reader needs them. */
export function renderGateOutput(
  outcome: GateOutcome,
  summary: GateSummary,
): string {
  if (outcome.mode.json) return renderGateJson(outcome, summary);

  const lines = [...outcome.notes];
  if (outcome.mode.report) lines.push(...renderInventory(outcome.inventory));
  lines.push(...outcome.findings.map(describeFinding));
  lines.push(
    `source budgets: ${summary.listed} listed, ${summary.errors} errors, ${summary.warnings} warnings, ${summary.overCeiling} over ceiling`,
  );
  return `${lines.join("\n")}\n`;
}

function renderGateJson(outcome: GateOutcome, summary: GateSummary): string {
  const payload = {
    ok: summary.errors === 0,
    mode: gateModeName(outcome.mode),
    profile: outcome.mode.profile,
    summary,
    notes: outcome.notes,
    findings: outcome.findings,
    ...(outcome.mode.report ? { inventory: outcome.inventory } : {}),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
