/**
 * The `any` keyword, wherever it is written: ceiling 0.
 *
 * One keyword revokes every guarantee the compiler had made about a value, in
 * line, with nothing recording that it happened. It is the same move whether
 * it is written as an annotation, as the argument of a generic, or as the type
 * of an assertion — so this counts the keyword itself rather than any of the
 * spellings around it.
 *
 * The count is taken from the parsed module, which is why this package can
 * measure a hatch it also has to name: the word inside a string or a comment
 * is not a keyword, so the question in the companion and the id of this signal
 * do not read as occurrences of the thing they describe.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReadings } from "../../doctor-signal.js";
import { countOccurrences, ts } from "../scanners/typescript-program.js";

function countAnyKeywords(context: DoctorContext): SignalReadings {
  return countOccurrences({
    program: context.program(),
    include: () => true,
    match: (node) => node.kind === ts.SyntaxKind.AnyKeyword,
    name: "any",
  });
}

export const explicitAnySignal: DoctorSignal = {
  id: "explicit-any",
  issue: "daddy-issues",
  question:
    "Does any hand-written file annotate a value `any`, or write `as any`?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence:
    "`any`? Not under this roof. Dad does not care if the other kids’ repos have it.",
  run: (context) => Promise.resolve(countAnyKeywords(context)),
};
