/**
 * A test that was turned off in place: ceiling 0.
 *
 * `skip` is a decision to stop asking a question, taken at the moment the
 * answer became inconvenient, recorded nowhere anybody reads. `only` is worse:
 * it turns off every other test in the file and the suite still reports green.
 * `todo` is a promise with no date on it.
 *
 * `skipIf(condition)` is not counted. A test that names the environment it
 * cannot run in is still asking its question everywhere else, and the
 * condition is the record the bare `skip` never had.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReadings } from "../../doctor-signal.js";
import { isTestSource } from "../scanners/source-classification.js";
import { countOccurrences, ts } from "../scanners/typescript-program.js";

const RUNNERS = new Set(["it", "test", "describe", "suite", "bench"]);
const SWITCHED_OFF = new Set(["skip", "only", "todo", "failing"]);

function isSwitchedOffTest(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!SWITCHED_OFF.has(callee.name.text)) return false;
  return ts.isIdentifier(callee.expression) && RUNNERS.has(callee.expression.text);
}

function countSkippedTests(context: DoctorContext): SignalReadings {
  return countOccurrences({
    program: context.program(),
    include: isTestSource,
    match: isSwitchedOffTest,
    name: "switched-off test",
  });
}

export const skippedTestsSignal: DoctorSignal = {
  id: "skipped-tests",
  issue: "commitment-issues",
  question: "Is any `it.only`, `it.skip`, or `it.todo` present?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "You went no-contact with tests, then checked their status every five minutes in CI.",
  run: (context) => Promise.resolve(countSkippedTests(context)),
};
