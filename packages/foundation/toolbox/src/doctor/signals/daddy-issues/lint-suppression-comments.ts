/**
 * The lint suppression written into the source: ceiling 0.
 *
 * A repository has a supported way to record a lint exception — a
 * suppressions file the linter itself prunes when the suppression stops being
 * needed, and which a ratchet guards against growth. A comment in a source
 * file is the unsupported way: nothing prunes it and nothing counts it, so it
 * outlives the reason it was added.
 *
 * A key is emitted for every TypeScript file, zeros included, so a file that
 * loses its last suppression reports as being at the ceiling rather than as a
 * key nothing measures.
 *
 * This module is not named after the signal it defines, and `hatch-names.ts`
 * explains why: an import specifier is file text, and the signal counts that
 * text.
 */

import type { DoctorContext } from "../../doctor-context.js";
import { fileReading, type DoctorSignal, type SignalReadings } from "../../doctor-signal.js";
import { ESLINT_DISABLES_SIGNAL, ESLINT_DISABLE_MARK } from "../../hatch-names.js";
import { isTypeScriptSource } from "../scanners/source-classification.js";

function countSuppressionComments(context: DoctorContext): SignalReadings {
  const readings = new Map<string, ReturnType<typeof fileReading>>();
  for (const path of context.files()) {
    if (!isTypeScriptSource(path)) continue;
    const found = context.read(path).split(ESLINT_DISABLE_MARK).length - 1;
    readings.set(path, fileReading(path, found));
  }
  return readings;
}

export const lintSuppressionCommentsSignal: DoctorSignal = {
  id: ESLINT_DISABLES_SIGNAL,
  issue: "daddy-issues",
  question: `Does any TypeScript file carry an \`${ESLINT_DISABLE_MARK}\` comment?`,
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "The compiler said something. You did not fix it. You put a comment over its mouth.",
  measure: "eslintDisables",
  run: (context) => Promise.resolve(countSuppressionComments(context)),
};
