/**
 * `as` inside a test: ceiling 0.
 *
 * A test is where the assertion is most tempting and least defensible. The
 * value being asserted is one the test itself built, so if the type is wrong
 * the test is wrong, and the assertion has hidden the only place the mistake
 * was going to show. Worse, it makes the test a place where a different rule
 * applies to the same repository, which is the failure this issue is about.
 *
 * The same `as` in production source is counted by `type-assertions`; the two
 * scopes are read separately so one occurrence is never counted twice.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReadings } from "../../doctor-signal.js";
import { isTestSource } from "../scanners/source-classification.js";
import {
  countOccurrences,
  isWideningAssertion,
} from "../scanners/typescript-program.js";

function countTestAssertions(context: DoctorContext): SignalReadings {
  return countOccurrences({
    program: context.program(),
    include: isTestSource,
    match: isWideningAssertion,
    name: "as",
  });
}

export const assertionsInTestsSignal: DoctorSignal = {
  id: "assertions-in-tests",
  issue: "disorganized-attachment",
  question: "Does any test file use `as`?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence:
    "The compiler is not confused. The compiler is the only one being honest with you.",
  run: (context) => Promise.resolve(countTestAssertions(context)),
};
