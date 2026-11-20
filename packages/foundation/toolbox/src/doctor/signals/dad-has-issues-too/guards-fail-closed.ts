/**
 * A guard that blocks when its own tool is missing: report-only.
 *
 * This is the reading Dad points at himself. A guard exists to stop a change
 * that should not land. A guard that also stops every change on a machine
 * where the formatter was never installed has stopped being a boundary and
 * become an outage — and the person it locks out is whoever cloned the
 * repository this morning, not whoever was trying to get past it.
 *
 * What is asked is narrow on purpose. The guards are the programs a harness
 * configuration actually runs at edit time, not every script in the tree, and
 * the question is asked only of the ones that shell out to a tool: a guard
 * that decides from its input alone has no tool to be missing. Of those, one
 * that names none of the ways a tool can be absent — an existence check, the
 * error a spawn returns, a catch — has no branch on which it could let the
 * edit through.
 *
 * It is report-only in both profiles, and it should be read as a prompt to go
 * and look rather than as a verdict: a scanner can see that a program never
 * mentions the failure, and cannot see what it does about it.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import { guardScriptOf, wiredGuards } from "../scanners/text-agent-harness.js";

const SPAWNS_A_TOOL =
  /\b(?:spawnSync|spawn|execSync|execFileSync|execFile)\s*\(/;
const HANDLES_ABSENCE =
  /\b(?:existsSync|ENOENT|catch|command -v|which)\b|\.error\b/;

function countGuardsThatFailClosed(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const guard of wiredGuards(context)) {
    const script = guardScriptOf(guard.command);
    if (script === undefined || !context.exists(script)) continue;
    const text = context.read(script);
    if (!SPAWNS_A_TOOL.test(text)) continue;
    readings.set(script, {
      value: HANDLES_ABSENCE.test(text) ? 0 : 1,
      evidence: [{ path: script, name: guard.path }],
    });
  }
  return readings;
}

export const guardsFailClosedSignal: DoctorSignal = {
  id: "guards-fail-closed",
  issue: "dad-has-issues-too",
  question:
    "Does any guard block a change when its own tool is missing, rather than failing open? (heuristic)",
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: null },
  sentence:
    "A missing tool fails open, because a house nobody can enter is not strict, it is empty.",
  run: (context) => Promise.resolve(countGuardsThatFailClosed(context)),
};
