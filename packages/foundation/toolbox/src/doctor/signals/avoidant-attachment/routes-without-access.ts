/**
 * A route blueprint with no access declaration: ceiling 0.
 *
 * This is the latchkey route. Nobody declared who may call it, so the answer is
 * decided somewhere else, or nowhere, and a reader of the blueprint cannot tell
 * which. It is cross-listed: the missing contract is avoidant attachment, and
 * the route raising itself is the cycle repeating, so the companion asks the
 * same question twice and the doctor measures it once.
 *
 * The reading is per operation and it is one or nothing: a route either says
 * who may call it or it does not. Where no blueprint exists there is nothing to
 * read, and the signal says it was not measured rather than reporting that a
 * repository with no routes has no unprotected ones.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading } from "../../doctor-signal.js";
import {
  operationEvidence,
  operationKey,
  readRouteModel,
} from "../scanners/route-model.js";

function countRoutesWithoutAccess(context: DoctorContext) {
  const readings = new Map<string, SignalReading>();
  for (const operation of readRouteModel(context).operations) {
    readings.set(operationKey(operation), {
      value: operation.declaresAccess ? 0 : 1,
      evidence: [operationEvidence(operation)],
    });
  }
  return readings;
}

export const routesWithoutAccessSignal: DoctorSignal = {
  id: "routes-without-access",
  issue: "avoidant-attachment",
  alsoUnder: ["you-repeat-the-cycle"],
  question: "Does any route blueprint carry no access declaration?",
  reads: "routes",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "Latchkey routes. Nobody home. No access declaration.",
  run: (context) => Promise.resolve(countRoutesWithoutAccess(context)),
};
