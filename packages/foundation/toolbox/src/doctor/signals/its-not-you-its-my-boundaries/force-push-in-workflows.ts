/**
 * A workflow that overwrites the default branch: ceiling 0.
 *
 * The gate runs against what is on the branch. A force push replaces what is
 * on the branch with something that never went through it, and does it from a
 * machine where nobody is watching the output. Every other bypass in this
 * issue needs a person to decide; this one needs a merge.
 *
 * A line has to do both things before it is counted: push with force, and name
 * a default branch. A force push of a release tag or of a throwaway preview
 * branch is a normal thing for a workflow to do, and a reading that counted it
 * would be one more rule people learn to work around.
 *
 * Only workflows are read. A guard that denies the command by matching it, or
 * a document that forbids it by name, is the opposite of the failure, and
 * `no-verify-in-scripts` explains at more length why Dad does not count those.
 *
 * A key is emitted for every workflow, zeros included, so a pipeline that
 * gains a forced push reports as being over rather than as a key nothing
 * measures.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import { DEFAULT_BRANCH, FORCE_PUSH } from "../scanners/text-bypass-marks.js";
import {
  ciWorkflowFiles,
  matchingLines,
} from "../scanners/text-ci-workflows.js";

function countForcedPushes(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const path of ciWorkflowFiles(context.files())) {
    const found = matchingLines(context.read(path), FORCE_PUSH).filter((line) =>
      DEFAULT_BRANCH.test(line.text),
    );
    readings.set(path, {
      value: found.length,
      evidence: found.map((line) => ({ path, line: line.line })),
    });
  }
  return readings;
}

export const forcePushInWorkflowsSignal: DoctorSignal = {
  id: "force-push-in-workflows",
  issue: "its-not-you-its-my-boundaries",
  question: "Does any workflow force-push the default branch?",
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "He will turn this workspace around. Do not think he won’t.",
  run: (context) => Promise.resolve(countForcedPushes(context)),
};
