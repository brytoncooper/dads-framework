/**
 * Impure barrels: ceiling 0.
 *
 * A package's `src/index.ts` is its public surface, and the only thing a
 * public surface should do is name what is public. A barrel that also declares
 * a type, runs a constant, or re-implements a helper makes the surface a place
 * where behavior hides: consumers import it for one symbol and get the rest,
 * and the next contributor adds to the barrel because the barrel already has
 * code in it.
 *
 * "Pure" means every top-level statement is a re-export with a module
 * specifier. The count is taken from a skeleton of the source rather than from
 * a pattern over raw text, so a multi-line re-export and a declaration that
 * merely mentions the word `export` are told apart correctly.
 */

import type { DoctorContext } from "../../doctor-context.js";
import {
  fileReading,
  type DoctorSignal,
  type SignalReading,
  type SignalReadings,
} from "../../doctor-signal.js";
import {
  isReExportStatement,
  topLevelStatements,
} from "../scanners/top-level-declarations.js";

const BARREL = /^packages\/(?:[^/]+\/)+src\/index\.ts$/;

/** Top-level statements in `text` that are not re-exports. */
export function countImpureStatements(text: string): number {
  return topLevelStatements(text).filter(
    (statement) => !isReExportStatement(statement),
  ).length;
}

function countBarrelImpurity(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const path of context.files()) {
    if (!BARREL.test(path)) continue;
    readings.set(
      path,
      fileReading(path, countImpureStatements(context.read(path))),
    );
  }
  return readings;
}

export const barrelImpuritySignal: DoctorSignal = {
  id: "barrel-impurity",
  issue: "enmeshment",
  question:
    "Does a package's `src/index.ts` contain a statement that is not `export ... from`?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "The barrel is the same family with the front door taken off.",
  measure: "barrelImpurity",
  run: (context) => Promise.resolve(countBarrelImpurity(context)),
};
