/**
 * Packages held to the README template: a floor.
 *
 * A documentation check only checks the packages a conformance list names.
 * That list is an opt-in, which means the cheapest way to make a documentation
 * failure go away is to remove the package from the list. A floor closes that
 * exit: the list may grow and may never shrink.
 *
 * A floor has no threshold. Until the gate reads a recorded baseline the
 * number is reported and judged by nothing, which is what `report` means on
 * its line.
 */

import type { DoctorContext } from "../../doctor-context.js";
import { isRecord, isUnknownArray } from "../../../parse-guards.js";
import type { DoctorSignal, SignalReadings } from "../../doctor-signal.js";

const CONFORMANCE_FILE = "docs/readme-conformance.json";

function countConformancePackages(context: DoctorContext): SignalReadings {
  if (!context.exists(CONFORMANCE_FILE)) return new Map();
  const parsed: unknown = JSON.parse(context.read(CONFORMANCE_FILE));
  if (!isRecord(parsed)) return new Map();
  const listed: unknown = parsed["packages"];
  if (!isUnknownArray(listed)) return new Map();
  return new Map([["packages", { value: listed.length, evidence: [{ path: CONFORMANCE_FILE }] }]]);
}

export const docsConformancePackagesSignal: DoctorSignal = {
  id: "docs-conformance-packages",
  issue: "avoidant-attachment",
  question: "Does any package lack a README, or carry one outside the template?",
  reads: "text",
  unit: "count",
  direction: "floor",
  thresholds: { standard: null, strict: null },
  sentence:
    "The first consumer asks a question and you have nothing to hand them except a raw array and “docs coming soon.”",
  measure: "docsConformancePackages",
  run: (context) => Promise.resolve(countConformancePackages(context)),
};
