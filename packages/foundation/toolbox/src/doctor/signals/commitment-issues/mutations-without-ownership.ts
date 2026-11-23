/**
 * A creator that never wrote down who owns the row: ceiling 0.
 *
 * You created the row. You did not write the ownership tuple. From then on the
 * only thing that knows who owns it is the request that made it, and that
 * request is gone. Every later access check has to guess, and guessing is how a
 * tenant column ends up in a `WHERE` clause.
 *
 * Every `POST` operation is asked. The evidence is searched in the package that
 * declares the route rather than in the handler, because a route that delegates
 * is doing the right thing: the tuple is written by the operation it calls, and
 * demanding it inline would reward the handler that does too much. So the
 * reading is per operation and the answer is per package: a package that writes
 * ownership somewhere, or registers an executed ownership proof, has answered
 * for all of its creators, and one that does neither has answered for none.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading } from "../../doctor-signal.js";
import { packageFiles, type GraphPackage } from "../scanners/package-graph.js";
import { operationEvidence, operationKey, readRouteModel } from "../scanners/route-model.js";

const OWNERSHIP_MARKS = ["proveOwnershipIntent", "relationships.add(", ".owner(", ".owner."];
const READABLE = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

/** True when anything in the package writes an ownership relationship. */
function showsOwnership(context: DoctorContext, declared: GraphPackage): boolean {
  for (const path of packageFiles(context, declared)) {
    if (!READABLE.some((extension) => path.endsWith(extension))) continue;
    const text = context.read(path);
    if (OWNERSHIP_MARKS.some((mark) => text.includes(mark))) return true;
  }
  return false;
}

function countCreatorsWithoutOwnership(context: DoctorContext) {
  const model = readRouteModel(context);
  const answered = new Map<string, boolean>();
  for (const declared of model.packagesWithRoutes) {
    answered.set(declared.name, showsOwnership(context, declared));
  }
  const readings = new Map<string, SignalReading>();
  for (const operation of model.operations) {
    if (operation.method !== "POST") continue;
    const shown = answered.get(operation.packageName) ?? false;
    readings.set(operationKey(operation), {
      value: shown || operation.resourceFreeTelemetry === true ? 0 : 1,
      evidence: [operationEvidence(operation)],
    });
  }
  return readings;
}

export const mutationsWithoutOwnershipSignal: DoctorSignal = {
  id: "mutations-without-ownership",
  issue: "commitment-issues",
  question: "Does a create route write no ownership tuple and carry no ownership proof?",
  reads: "routes",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "You created the row. You did not write the ownership tuple. You said labels make you uncomfortable.",
  run: (context) => Promise.resolve(countCreatorsWithoutOwnership(context)),
};
