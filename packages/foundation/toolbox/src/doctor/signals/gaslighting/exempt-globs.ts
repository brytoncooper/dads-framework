/**
 * Baseline exemptions that reach hand-written code: report-only in standard,
 * ceiling 0 in strict.
 *
 * An exemption is the one thing in a ratchet that is not measured at all. That
 * is correct for output nobody typed — a generated module, a build directory —
 * because measuring it would record a number that changes when a generator
 * does. It is the perfect hiding place for everything else, and it hides
 * quietly: the file is still in the repository, still imported, still read by
 * a reviewer, and simply absent from every count.
 *
 * So the reading is about the shape of the glob rather than about what it
 * currently matches. A glob naming generated output or a build directory is
 * the exemption doing its job. Any other glob is an exemption whose reach a
 * reader has to work out by hand, and the two are not the same promise.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading, SignalReadings } from "../../doctor-signal.js";
import { BASELINE_FILE, baselineExemptions } from "../scanners/text-ratchet-baseline.js";

const GENERATED_MARKS = ["generated", ".d.ts", ".snap", ".lock"];
const OUTPUT_DIRECTORIES = new Set([
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "node_modules",
  ".next",
  ".turbo",
  ".output",
  "__generated__",
]);

/** True when the glob can only reach output somebody's tools wrote. */
export function reachesOnlyGeneratedFiles(glob: string): boolean {
  const written = glob.toLowerCase();
  if (GENERATED_MARKS.some((mark) => written.includes(mark))) return true;
  return written.split("/").some((segment) => OUTPUT_DIRECTORIES.has(segment));
}

function countReachingExemptions(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const glob of baselineExemptions(context)) {
    readings.set(glob, {
      value: reachesOnlyGeneratedFiles(glob) ? 0 : 1,
      evidence: [{ path: BASELINE_FILE, name: glob }],
    });
  }
  return readings;
}

export const exemptGlobsSignal: DoctorSignal = {
  id: "exempt-globs",
  issue: "gaslighting",
  question: "Does a baseline exemption cover anything beyond generated files?",
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: 0 },
  sentence: "“That’s not a public contract. That’s just how the table looks.”",
  run: (context) => Promise.resolve(countReachingExemptions(context)),
};
