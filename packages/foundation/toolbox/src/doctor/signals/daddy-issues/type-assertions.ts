/**
 * `as` in production source: ceiling 0.
 *
 * An assertion is not a conversion. It is a sentence that says the compiler
 * was wrong and nobody has to prove it, and the proof was the only thing the
 * type was ever worth. `as const` is not counted: it narrows a literal to
 * itself and gives nothing away.
 *
 * Tests are counted by `assertions-in-tests` rather than here, because the
 * companion asks about them under a different issue — the failure there is one
 * rule in production and another in the test beside it — and one occurrence
 * must not be counted twice.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReadings } from "../../doctor-signal.js";
import { isTestSource } from "../scanners/source-classification.js";
import {
  countOccurrences,
  isWideningAssertion,
} from "../scanners/typescript-program.js";

function countTypeAssertions(context: DoctorContext): SignalReadings {
  return countOccurrences({
    program: context.program(),
    include: (path) => !isTestSource(path),
    match: isWideningAssertion,
    name: "as",
  });
}

export const typeAssertionsSignal: DoctorSignal = {
  id: "type-assertions",
  issue: "daddy-issues",
  question:
    "Does any hand-written file use `as` other than `as const`, or a postfix `!`?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "We don’t say `as` in this house. Use your narrowing words.",
  run: (context) => Promise.resolve(countTypeAssertions(context)),
};
