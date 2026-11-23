/**
 * A handler doing the work itself: ceiling 20 statements, 10 under strict.
 *
 * The route received the request. That is the whole of its job. Every statement
 * past the delegation is behavior that now lives where it cannot be called from
 * anywhere else, cannot be tested without a request, and cannot be given a name
 * of its own. Four years later it is still in the controller and still has no
 * public contract.
 *
 * The count is the statements the scanner can see in the handler's own body; a
 * handler that delegates in one expression reads one. The companion's question
 * has a second half — a handler that imports persistence directly — and that
 * half is a different unit with a different threshold, so it is answered by
 * `domain-in-apps` rather than folded into this number. One signal, one number,
 * one thing a reader can argue with.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading } from "../../doctor-signal.js";
import { operationEvidence, operationKey, readRouteModel } from "../scanners/route-model.js";

function countHandlerWork(context: DoctorContext) {
  const readings = new Map<string, SignalReading>();
  for (const operation of readRouteModel(context).operations) {
    readings.set(operationKey(operation), {
      value: operation.handlerStatements,
      evidence: [operationEvidence(operation)],
    });
  }
  return readings;
}

export const logicInControllersSignal: DoctorSignal = {
  id: "logic-in-controllers",
  issue: "failure-to-launch",
  question: "Does a route handler exceed the profile's statement threshold?",
  reads: "routes",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 20, strict: 10 },
  sentence: "Four years. Still lives in the controller. Still no public contract.",
  run: (context) => Promise.resolve(countHandlerWork(context)),
};
