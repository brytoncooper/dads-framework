/**
 * Cases in the doctor's own fixture corpus: a floor.
 *
 * Decision five of the plan this command comes from is that every signal ships
 * with a fixture that trips it. A rule that fires without a case somebody can
 * run is the helicopter dad `DAD.md` warns about, and the cheapest way to make
 * a broken signal look fine is to delete its case. So the corpus is the one
 * thing Dad holds against himself: the case count may rise and may never fall,
 * and a signal added without a case shows up as a corpus that did not grow.
 *
 * A case is a directory rather than a line in a shared index, because an index
 * is one file every lane adding a signal has to edit at once. So the count is
 * the directories under `fixtures/daddy-issues/` holding a readable
 * `fixture.json` whose `signal` is the directory's own name — a manifest that
 * names somewhere else is not a case, and cannot raise the floor by sitting in
 * the corpus. That the named signal is a registered one is the corpus test's
 * question: it holds the directory names and the registered ids to be one set.
 */

import { isRecord, isString } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReadings } from "../../doctor-signal.js";

const CORPUS_DIRECTORY = "fixtures/daddy-issues";
const MANIFEST = "fixture.json";

/** The manifest as JSON, or `undefined` when it cannot be read or parsed. */
function readManifest(context: DoctorContext, path: string): unknown {
  if (!context.exists(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(context.read(path));
    return parsed;
  } catch {
    return undefined;
  }
}

/** True when the directory's own manifest names the directory. */
function isCase(context: DoctorContext, name: string): boolean {
  const manifest = readManifest(
    context,
    `${CORPUS_DIRECTORY}/${name}/${MANIFEST}`,
  );
  const signal: unknown = isRecord(manifest) ? manifest["signal"] : undefined;
  return isString(signal) && signal === name;
}

function countDoctorCases(context: DoctorContext): SignalReadings {
  const cases = context
    .directories(CORPUS_DIRECTORY)
    .filter((name) => isCase(context, name));
  if (cases.length === 0) return new Map();
  return new Map([
    [
      "cases",
      {
        value: cases.length,
        evidence: cases.map((name) => ({
          path: `${CORPUS_DIRECTORY}/${name}`,
        })),
      },
    ],
  ]);
}

export const doctorCasesSignal: DoctorSignal = {
  id: "doctor-cases",
  issue: "dad-has-issues-too",
  question: "Does any signal ship without a case that trips it?",
  reads: "text",
  unit: "count",
  direction: "floor",
  thresholds: { standard: null, strict: null },
  reportOnly: true,
  sentence: "Every rule names the change it stops, or it goes.",
  measure: "doctorCases",
  run: (context) => Promise.resolve(countDoctorCases(context)),
};
