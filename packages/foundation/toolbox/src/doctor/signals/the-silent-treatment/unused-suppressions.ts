/**
 * Suppressions for code that is not there any more: ceiling 0.
 *
 * A suppression is a promise about one rule in one file. When the file goes,
 * the promise outlives the thing it was about, and the record stops being a
 * list of things a repository knows about — which is the only property that
 * made writing it down better than a comment.
 *
 * This is the half of the question a text reading can answer honestly: an
 * entry whose file no longer exists cannot be producing a violation, and no
 * linter has to run to know it. The other half — an entry whose file is still
 * there and whose rule no longer fires — needs the linter's own answer, and
 * the linter already has a command that prunes those. Dad does not guess at
 * it, and a reading that guessed would either miss the stale entries it can
 * see or invent ones it cannot.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import {
  SUPPRESSIONS_FILE,
  suppressionEntries,
} from "../scanners/text-suppressions-file.js";

function countStaleSuppressions(context: DoctorContext): SignalReadings {
  const tracked = new Set(context.files());
  const readings = new Map<string, SignalReading>();
  for (const entry of suppressionEntries(context)) {
    const key = `${entry.path}:${entry.rule}`;
    readings.set(key, {
      value: tracked.has(entry.path) ? 0 : 1,
      evidence: [{ path: SUPPRESSIONS_FILE, name: key }],
    });
  }
  return readings;
}

export const unusedSuppressionsSignal: DoctorSignal = {
  id: "unused-suppressions",
  issue: "the-silent-treatment",
  question:
    "Does the suppressions file list a rule and file that no longer produce a violation?",
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence:
    "A ratchet is a list of things Dad knows about, not a list of things you hoped he would not notice.",
  run: (context) => Promise.resolve(countStaleSuppressions(context)),
};
