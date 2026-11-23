/**
 * `console.*` in production source: ceiling 0.
 *
 * A console call is a decision about output made by the module that happened
 * to notice something, rather than by whoever owns what this program says and
 * where it says it. It cannot be turned off, redirected, correlated, or
 * levelled, and in a library it prints into somebody else's process.
 *
 * Scripts and tests are exempt: a script's output is the point of running it,
 * and a test's console is the developer's. Everything else is production
 * source, whatever directory it sits in.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReadings } from "../../doctor-signal.js";
import { countOccurrences, isProductionModule, ts } from "../scanners/typescript-program.js";

function isConsoleCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  return ts.isIdentifier(callee.expression) && callee.expression.text === "console";
}

function countConsoleCalls(context: DoctorContext): SignalReadings {
  return countOccurrences({
    program: context.program(),
    include: isProductionModule,
    match: isConsoleCall,
    name: "console call",
  });
}

export const consoleInProductionSignal: DoctorSignal = {
  id: "console-in-production",
  issue: "you-repeat-the-cycle",
  question:
    "Is there a `console.*` call outside scripts and tests, or a directory named `helpers/`, `utils/`, `common/`, `misc/`, or `shared/`?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "Latchkey routes. Nobody home. No access declaration. Dinner is `console.log`.",
  run: (context) => Promise.resolve(countConsoleCalls(context)),
};
