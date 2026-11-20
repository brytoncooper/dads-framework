/**
 * A capability nobody can stand in for: report, then ceiling 0.
 *
 * This is Dad's test, and it is not the folder name. Write an in-memory
 * version of the provider and run it through the same conformance suite as the
 * real one. If you cannot write one, the capability is not a contract you own;
 * it is the vendor's shape with a local name, and every consumer past it needs
 * the vendor running to be tested at all.
 *
 * The reading is a capability with exactly one implementer, and that one not a
 * stand-in. A stand-in is a name or a module that says in-memory, fake, or
 * stub, and so is any implementer outside production source: a test that
 * builds one has already answered the question this asks. Two real providers
 * pass too — a capability somebody has implemented twice has been shown to be
 * implementable twice, which is the whole point.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalEvidence,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import { readCapabilities } from "../scanners/capability-model.js";
import { isProductionModule } from "../scanners/typescript-program.js";

const STAND_IN = /in[-_ ]?memory|fake|stub/i;

function isStandIn(evidence: SignalEvidence): boolean {
  if (!isProductionModule(evidence.path)) return true;
  return STAND_IN.test(evidence.name ?? "") || STAND_IN.test(evidence.path);
}

function countMissingStandIns(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const capability of readCapabilities(context.program())) {
    if (capability.implementers.length !== 1) continue;
    if (capability.implementers.some(isStandIn)) continue;
    readings.set(`${capability.declaredIn} ${capability.name}`, {
      value: 1,
      evidence: [capability.evidence, ...capability.implementers],
    });
  }
  return readings;
}

export const noInMemoryProviderSignal: DoctorSignal = {
  id: "no-in-memory-provider",
  issue: "the-paper-wall",
  question:
    "Does a capability have exactly one implementer and no in-memory stand-in?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: 0 },
  sentence:
    "If you cannot write one, you did not build a wall. You hung a curtain and put a lock on it.",
  run: (context) => Promise.resolve(countMissingStandIns(context)),
};
