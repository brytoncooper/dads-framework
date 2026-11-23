/**
 * Cases in the sealed soundness corpus: a floor.
 *
 * A test-selection planner is only as trustworthy as the corpus that proves it
 * picks the same tasks before and after a change. That makes deleting a case
 * the cheapest way to make a refactor look safe, which is exactly what this
 * floor forbids. Cases are counted structurally, from the array, so
 * reformatting the file cannot move the number.
 */

import { isRecord, isString, isUnknownArray } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReadings } from "../../doctor-signal.js";

const CORPUS_FILE = "fixtures/testing-soundness/cases.json";

function countSoundnessCases(context: DoctorContext): SignalReadings {
  if (!context.exists(CORPUS_FILE)) return new Map();
  const parsed: unknown = JSON.parse(context.read(CORPUS_FILE));
  const cases: unknown = isRecord(parsed) ? parsed["cases"] : undefined;
  if (!isUnknownArray(cases)) return new Map();
  const defined = cases.filter((entry) => isRecord(entry) && isString(entry["id"]));
  return new Map([["cases", { value: defined.length, evidence: [{ path: CORPUS_FILE }] }]]);
}

export const soundnessCasesSignal: DoctorSignal = {
  id: "soundness-cases",
  issue: "commitment-issues",
  question: "Has the sealed test-selection corpus lost a case?",
  reads: "text",
  unit: "count",
  direction: "floor",
  thresholds: { standard: null, strict: null },
  sentence: "You do not want a relationship. You just need to know they still pass.",
  measure: "soundnessCases",
  run: (context) => Promise.resolve(countSoundnessCases(context)),
};
