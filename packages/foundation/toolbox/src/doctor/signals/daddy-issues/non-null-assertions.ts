/**
 * The postfix `!`: ceiling 0.
 *
 * One character deletes `undefined` from a type and leaves no record that
 * anybody decided it was safe. It is the smallest of the hatches and the
 * hardest to find in review, because it looks like punctuation.
 *
 * Unlike `as`, this is counted in tests too. A test that asserts a value is
 * present is a test that will report the wrong failure when it stops being
 * present, and there is no scope in which that reads better.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReadings } from "../../doctor-signal.js";
import { countOccurrences, ts } from "../scanners/typescript-program.js";

function countNonNullAssertions(context: DoctorContext): SignalReadings {
  return countOccurrences({
    program: context.program(),
    include: () => true,
    match: (node) => ts.isNonNullExpression(node),
    name: "non-null assertion",
  });
}

export const nonNullAssertionsSignal: DoctorSignal = {
  id: "non-null-assertions",
  issue: "daddy-issues",
  question:
    "Does any hand-written file use `as` other than `as const`, or a postfix `!`?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "You can smell a fatherless codebase. The `any`s. The hope.",
  run: (context) => Promise.resolve(countNonNullAssertions(context)),
};
