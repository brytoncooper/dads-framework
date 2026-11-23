/**
 * A module that imports from more than fifteen places: report, then 15.
 *
 * Fan-out is how a file tells you it has more than one responsibility before
 * it has grown long enough for the line ceiling to say so. Sixteen imports
 * means sixteen reasons to be recompiled, sixteen things to stub before it can
 * be tested, and a name that cannot describe what it does without a list.
 *
 * The count is distinct module specifiers a module *imports*, so importing
 * four names from one module is one edge and a barrel re-exporting sixteen is
 * none: a surface listing is what a barrel is for, and `barrel-impurity` is
 * the signal that reads whether it is only that.
 *
 * Report-only under `standard` and 15 under `strict`, so the modules this
 * emits are the ones already at or over that ceiling.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading, SignalReadings } from "../../doctor-signal.js";
import { isProductionModule, moduleImports } from "../scanners/typescript-program.js";

/** The count `strict` refuses, which is also the count worth reporting. */
const CEILING = 15;

function countFanOut(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const module of context.program().modules) {
    if (!isProductionModule(module.path)) continue;
    const reached = new Set(
      moduleImports(module)
        .filter((imported) => !imported.reExport)
        .map((imported) => imported.specifier),
    );
    if (reached.size <= CEILING) continue;
    readings.set(module.path, {
      value: reached.size,
      evidence: [...reached].sort().map((specifier) => ({ path: module.path, name: specifier })),
    });
  }
  return readings;
}

export const fanOutSignal: DoctorSignal = {
  id: "fan-out",
  issue: "enmeshment",
  question: "Does any module import from more places than the profile allows?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: CEILING },
  sentence: "Enmeshed families cannot tell you who they are. They can only tell you who they are standing next to.",
  run: (context) => Promise.resolve(countFanOut(context)),
};
