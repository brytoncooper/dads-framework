/**
 * The same helper, written again: ceiling 1.
 *
 * `DAD.md` names the shape this exists to stop — fourteen hand-rolled
 * `isRecord`s, each one a little different, none of them the one a reader
 * expects. The cost is not the duplicated lines; it is that a fix applied to
 * one copy leaves the other thirteen wrong, and nobody can tell which copy a
 * given call site meant.
 *
 * The count is per package, because a package is the unit that can share a
 * helper without an import crossing a boundary: two packages that each declare
 * `isRecord` have a naming coincidence, while two files in one package have a
 * duplicate. The ceiling is 1, so a name declared in one file is at the ceiling
 * and a name declared in two is over it. Migration modules can repeat their
 * entry points and stay outside this count.
 *
 * Every collected pair is emitted, including the ones at 1, so a deduplicated
 * name stays visible at the ceiling instead of reading as a key nothing
 * measures.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalEvidence, SignalReading, SignalReadings } from "../../doctor-signal.js";
import { isProductionTypeScript, packageRootOf } from "../scanners/source-classification.js";
import { topLevelFunctionNames } from "../scanners/top-level-declarations.js";

function countRedeclaredHelpers(context: DoctorContext): SignalReadings {
  const declaringFiles = new Map<string, SignalEvidence[]>();
  for (const path of context.files()) {
    if (!isProductionTypeScript(path)) continue;
    if (path.endsWith(".migration.ts")) continue;
    const owner = packageRootOf(path);
    for (const name of topLevelFunctionNames(context.read(path))) {
      const key = `${owner}:${name}`;
      const found = declaringFiles.get(key) ?? [];
      found.push({ path, name });
      declaringFiles.set(key, found);
    }
  }

  const readings = new Map<string, SignalReading>();
  for (const [key, evidence] of declaringFiles) {
    readings.set(key, { value: evidence.length, evidence });
  }
  return readings;
}

export const duplicatedHelpersSignal: DoctorSignal = {
  id: "duplicated-helpers",
  issue: "anxious-attachment",
  question: "Is the same function name defined in more than one production file of one package?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  // A value of 1 is one file declaring the name; the ceiling is on extra
  // declarations, so strict cannot go below 1 without flagging every helper.
  thresholds: { standard: 1, strict: 1 },
  sentence:
    "You have fourteen `isRecord`s. Fourteen. None of them can tell you what a record is, and each one is sure the other thirteen would get it wrong.",
  measure: "duplicatedHelpers",
  run: (context) => Promise.resolve(countRedeclaredHelpers(context)),
};
