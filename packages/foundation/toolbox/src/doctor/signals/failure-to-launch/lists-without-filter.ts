/**
 * A list route that takes no query: ceiling 0.
 *
 * A list with no query schema is a list that returns everything, and it stays
 * that way until the day it cannot. Then the filter arrives as a parameter
 * nobody declared, a header, or a second route, because the contract never had
 * a place to put one. The query schema is that place, and declaring it is what
 * makes paging and filtering a change to a contract instead of a new endpoint.
 *
 * A list route is one that declares an `item`: the operation returns a page of
 * a shape rather than one of it. Everything else is not asked, and a workspace
 * with no list routes reports that it was not measured.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading } from "../../doctor-signal.js";
import { isListOperation, operationEvidence, operationKey, readRouteModel } from "../scanners/route-model.js";

function countUnfilteredLists(context: DoctorContext) {
  const readings = new Map<string, SignalReading>();
  for (const operation of readRouteModel(context).operations) {
    if (!isListOperation(operation)) continue;
    readings.set(operationKey(operation), {
      value: operation.schemas.query === undefined ? 1 : 0,
      evidence: [operationEvidence(operation)],
    });
  }
  return readings;
}

export const listsWithoutFilterSignal: DoctorSignal = {
  id: "lists-without-filter",
  issue: "failure-to-launch",
  question: "Does a list route have no query schema?",
  reads: "routes",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "You said you were fine. You shipped the list with no filter. You were not fine.",
  run: (context) => Promise.resolve(countUnfilteredLists(context)),
};
