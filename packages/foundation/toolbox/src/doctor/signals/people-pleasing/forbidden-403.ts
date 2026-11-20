/**
 * A 403 anywhere a route can reach: ceiling 0.
 *
 * 403 tells a caller that the thing exists and they may not have it. That is a
 * sentence about the family's trampoline, delivered to a stranger, and no
 * amount of politeness in the body takes it back. Dad's answer is 404: absence
 * and denial look the same from outside, so a caller with no relationship
 * learns nothing at all.
 *
 * The reading is per package, over the production sources of the packages that
 * declare routes, with comments removed so an essay arguing against 403 is not
 * counted as one. A repository with no blueprints has no routes to return it
 * and the signal says it was not measured: the number would otherwise be a zero
 * that means "nothing was looked at".
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalEvidence,
  SignalReading,
} from "../../doctor-signal.js";
import { strippedSourceLines } from "../scanners/package-graph.js";
import { readRouteModel } from "../scanners/route-model.js";

const FORBIDDEN_STATUS = /\b403\b/;

function forbiddenLinesIn(
  context: DoctorContext,
  paths: readonly string[],
): readonly SignalEvidence[] {
  const found: SignalEvidence[] = [];
  for (const path of paths) {
    for (const [index, line] of strippedSourceLines(
      context.read(path),
    ).entries()) {
      if (FORBIDDEN_STATUS.test(line)) {
        found.push({ path, line: index + 1, name: "403" });
      }
    }
  }
  return found;
}

function countForbidden(context: DoctorContext) {
  const readings = new Map<string, SignalReading>();
  for (const declared of readRouteModel(context).packagesWithRoutes) {
    const evidence = forbiddenLinesIn(context, declared.sources);
    readings.set(declared.name, { value: evidence.length, evidence });
  }
  return readings;
}

export const forbidden403Signal: DoctorSignal = {
  id: "forbidden-403",
  issue: "people-pleasing",
  question: "Does any route return 403?",
  reads: "routes",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "Existence is not a prize you owe a stranger. Dad said just 404.",
  run: (context) => Promise.resolve(countForbidden(context)),
};
