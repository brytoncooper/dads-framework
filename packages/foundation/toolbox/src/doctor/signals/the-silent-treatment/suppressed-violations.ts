/**
 * The standing suppressions, per file: judged by the recorded ceiling.
 *
 * A suppressions file is the healthy version of the escape hatch — written
 * down, read by the tool rather than by a person, and prunable. What makes it
 * the silent treatment instead is nothing about its contents: it is that
 * nothing requires the number to fall. So the number is what this reads, per
 * file, so that a mark can be recorded per file and a file that adds a
 * suppression is the one that has to explain itself.
 *
 * It has no threshold of Dad's. A repository's suppression count is its own
 * history, and the only honest judge of it is the baseline it recorded, which
 * is the gate's job. Until then the number is printed and judged by nothing.
 *
 * An entry whose file is gone is not counted here. That is
 * `unused-suppressions`, and counting a stale record as a standing suppression
 * would let a deleted file keep a ceiling alive.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading, SignalReadings } from "../../doctor-signal.js";
import { SUPPRESSIONS_FILE, suppressionEntries } from "../scanners/text-suppressions-file.js";

function countSuppressedViolations(context: DoctorContext): SignalReadings {
  const tracked = new Set(context.files());
  const readings = new Map<string, SignalReading>();
  for (const entry of suppressionEntries(context)) {
    if (!tracked.has(entry.path)) continue;
    const known = readings.get(entry.path);
    readings.set(entry.path, {
      value: (known?.value ?? 0) + entry.count,
      evidence: [...(known?.evidence ?? []), { path: SUPPRESSIONS_FILE, name: `${entry.path}: ${entry.rule}` }],
    });
  }
  return readings;
}

export const suppressedViolationsSignal: DoctorSignal = {
  id: "suppressed-violations",
  issue: "the-silent-treatment",
  question: "Does the suppressions file hold more entries than its recorded ceiling?",
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: null },
  sentence: "A suppressions file nobody has opened since the day it was generated.",
  run: (context) => Promise.resolve(countSuppressedViolations(context)),
};
