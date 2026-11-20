/**
 * A capability with one implementer and one consumer: report-only, both
 * profiles. A heuristic.
 *
 * Twelve abstractions in week one is the shape this reads. An interface with
 * one implementation and one caller is not a boundary; it is a second name for
 * the same thing, and every change now has to be made in both. It may become a
 * boundary — the second provider is sometimes a quarter away — which is why
 * this never gets a threshold in either profile. It is a list to be argued
 * with, not a rule.
 *
 * The same reading under `the paper wall` asks a sharper question:
 * `no-in-memory-provider` narrows this to the capabilities that also have no
 * stand-in, and those are the ones where the boundary was announced and never
 * built.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import { readCapabilities } from "../scanners/capability-model.js";

function countSingleImplementers(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const capability of readCapabilities(context.program())) {
    if (capability.implementers.length !== 1) continue;
    if (capability.consumers.length !== 1) continue;
    readings.set(`${capability.declaredIn} ${capability.name}`, {
      value: 1,
      evidence: [capability.evidence, ...capability.implementers],
    });
  }
  return readings;
}

export const singleImplementerAbstractionsSignal: DoctorSignal = {
  id: "single-implementer-abstractions",
  issue: "commitment-issues",
  alsoUnder: ["the-paper-wall"],
  question:
    "Is there a type with exactly one implementer and one consumer? (heuristic)",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: null },
  sentence:
    "Love-bombed the codebase. Twelve abstractions. Week one. By Thursday he’d moved out and changed his name to `utils`.",
  run: (context) => Promise.resolve(countSingleImplementers(context)),
};
