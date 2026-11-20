/**
 * Packages carrying an `INVARIANTS.md`: a floor per package.
 *
 * A domain's invariants are the rules its code enforces that no type
 * expresses — the ones a reader can only learn by finding the `if` that
 * throws. Writing them down is cheap and losing them is silent, so this signal
 * holds each package's file individually rather than counting them all into
 * one number. One floor per package is the whole point: a shared count would
 * let a package delete its invariants the same week another package writes its
 * first, and the total would say nothing happened.
 *
 * Only the packages that ship behavior are asked for one. An `artifact` is a
 * build product rather than a place invariants live, so it is emitted at zero
 * and never expected to rise. A package with no declared `kind` throws rather
 * than counting as zero.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";

const PROJECT_FILE = "dads.project.json";
const INVARIANTS_FILE = "INVARIANTS.md";
const MEASURED_ROOTS = ["packages/", "apps/"];
const ARTIFACT_KIND = "artifact";

function countInvariantsFiles(context: DoctorContext): SignalReadings {
  if (!context.exists(PROJECT_FILE)) return new Map();
  const tracked = new Set(context.files());
  const readings = new Map<string, SignalReading>();
  for (const declared of context.packages()) {
    if (declared.kind === undefined) {
      throw new Error(
        `${PROJECT_FILE}: package "${declared.name}" declares no kind; every package says what it is`,
      );
    }
    if (!MEASURED_ROOTS.some((prefix) => declared.root.startsWith(prefix))) {
      continue;
    }
    const path = `${declared.root}/${INVARIANTS_FILE}`;
    const present = tracked.has(path) && declared.kind !== ARTIFACT_KIND;
    readings.set(declared.name, {
      value: present ? 1 : 0,
      evidence: [{ path }],
    });
  }
  return readings;
}

export const invariantsFilesSignal: DoctorSignal = {
  id: "invariants-files",
  issue: "avoidant-attachment",
  question: "Does any non-artifact package lack an `INVARIANTS.md`?",
  reads: "packages",
  unit: "count",
  direction: "floor",
  thresholds: { standard: null, strict: null },
  sentence:
    "Then you ghosted your invariants. They still watch your deployments.",
  measure: "invariantsFiles",
  run: (context) => Promise.resolve(countInvariantsFiles(context)),
};
