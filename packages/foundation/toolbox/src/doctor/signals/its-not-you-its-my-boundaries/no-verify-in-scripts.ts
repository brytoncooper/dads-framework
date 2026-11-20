/**
 * The commit-hook bypass written into something that runs: ceiling 0.
 *
 * A hook is only a boundary while nothing routes around it, and the flag that
 * routes around it is one word long. Written once into a script, it stops
 * being a decision somebody makes under pressure and becomes the way the
 * repository works.
 *
 * The reading is of the places a command line executes: a manifest's scripts,
 * a workflow, a git hook, a shell script. It is deliberately not a search of
 * every file, and the reason is in this repository's own tree — the essay
 * names the flag, the companion names it, the house rules forbid it by name,
 * and the shell guard denies it by matching it. A reading that counted those
 * would be a rule firing on the four places that forbid the thing it is
 * looking for, which is the helicopter dad the plan warns about. What Dad
 * counts is the bypass being available to run, not the bypass being discussed.
 *
 * The flag itself is joined at load time in `text-bypass-marks.ts`, for the
 * reason `hatch-names.ts` gives about the escape hatches.
 *
 * A key is emitted for every such file, zeros included, so a script that gains
 * the bypass reports as being over rather than as a key nothing measures.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import { COMMIT_HOOK_BYPASS } from "../scanners/text-bypass-marks.js";
import {
  ciWorkflowFiles,
  isShellScript,
  matchingLines,
} from "../scanners/text-ci-workflows.js";

const MANIFEST_SUFFIX = "package.json";

function isCommandFile(path: string, workflows: ReadonlySet<string>): boolean {
  if (workflows.has(path) || isShellScript(path)) return true;
  return path === MANIFEST_SUFFIX || path.endsWith(`/${MANIFEST_SUFFIX}`);
}

function countBypassesInCommands(context: DoctorContext): SignalReadings {
  const workflows = new Set(ciWorkflowFiles(context.files()));
  const bypass = new RegExp(COMMIT_HOOK_BYPASS);
  const readings = new Map<string, SignalReading>();
  for (const path of context.files()) {
    if (!isCommandFile(path, workflows)) continue;
    const found = matchingLines(context.read(path), bypass);
    readings.set(path, {
      value: found.length,
      evidence: found.map((line) => ({ path, line: line.line })),
    });
  }
  return readings;
}

export const noVerifyInScriptsSignal: DoctorSignal = {
  id: "no-verify-in-scripts",
  issue: "its-not-you-its-my-boundaries",
  question:
    "Does the commit-hook bypass appear in a script, a workflow, or a git hook?",
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence:
    "Dad changed the locks. The guard says no before the shell ever sees it.",
  run: (context) => Promise.resolve(countBypassesInCommands(context)),
};
