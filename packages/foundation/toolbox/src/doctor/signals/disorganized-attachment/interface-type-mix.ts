/**
 * `interface` where the house rule is `type`: ceiling 0.
 *
 * The two keywords are not the failure. The mixture is. An `interface` can be
 * reopened and added to from another file, and a `type` cannot, so a package
 * that uses both has two rules about whether a declaration is finished and no
 * way for a reader to tell which one a given file was written under.
 *
 * The house rule is `type`, so an `interface` declaration is the occurrence
 * counted, wherever it is written. A declaration inside a `.d.ts` is not
 * counted because nobody typed it.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReadings } from "../../doctor-signal.js";
import { countOccurrences, ts } from "../scanners/typescript-program.js";

function countInterfaces(context: DoctorContext): SignalReadings {
  return countOccurrences({
    program: context.program(),
    include: () => true,
    match: (node) => ts.isInterfaceDeclaration(node),
    name: "interface",
  });
}

export const interfaceTypeMixSignal: DoctorSignal = {
  id: "interface-type-mix",
  issue: "disorganized-attachment",
  question:
    "Does any file declare an `interface` where the house rule is `type`?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence:
    "Zod in public. A hand-written interface in private. `as` after midnight.",
  run: (context) => Promise.resolve(countInterfaces(context)),
};
