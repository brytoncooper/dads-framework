/**
 * Recorded exceptions that do not say what they are: ceiling 0.
 *
 * A ratchet baseline is a list of things a repository has agreed to carry, and
 * the reason field is the whole of what separates that from a list of things
 * nobody looked at. An entry with no reason cannot be argued with, cannot be
 * scheduled for removal, and cannot be told apart from an entry somebody added
 * to make a red build go away — which is the rename that gaslighting is.
 *
 * Boilerplate is counted with absence, and the list of it is short on purpose.
 * A placeholder is a word standing where a reason should be: `todo`, `wip`,
 * `n/a`. A date is not one. The ratchet writes `recorded <date>` itself when it
 * seeds a floor, and the date is the true and useful fact that the floor was
 * measured rather than chosen; demanding prose there would only teach people to
 * write prose.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading, SignalReadings } from "../../doctor-signal.js";
import { BASELINE_FILE, baselineEntries } from "../scanners/text-ratchet-baseline.js";

const PLACEHOLDERS = new Set([
  "todo",
  "tbd",
  "wip",
  "temp",
  "temporary",
  "n/a",
  "na",
  "none",
  "fixme",
  "later",
  "-",
  "?",
  "reason",
  "no reason",
]);

/** True when the reason says nothing a reader could disagree with. */
export function isUnexplained(reason: string | undefined): boolean {
  if (reason === undefined) return true;
  const written = reason
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "");
  return written.length === 0 || PLACEHOLDERS.has(written);
}

function countUnexplainedEntries(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const entry of baselineEntries(context)) {
    const key = `${entry.section}.${entry.measure}.${entry.key}`;
    readings.set(key, {
      value: isUnexplained(entry.reason) ? 1 : 0,
      evidence: [{ path: BASELINE_FILE, name: key }],
    });
  }
  return readings;
}

export const baselineEntriesWithoutReasonSignal: DoctorSignal = {
  id: "baseline-entries-without-reason",
  issue: "gaslighting",
  question: "Does any ratchet baseline entry have an empty or boilerplate reason?",
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence:
    "First you rename the violation. Then you explain why it had to happen. Then you ask why everybody is being so rigid.",
  run: (context) => Promise.resolve(countUnexplainedEntries(context)),
};
