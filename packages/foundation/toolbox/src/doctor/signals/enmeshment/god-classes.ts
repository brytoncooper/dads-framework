/**
 * A class with more than twelve methods: report, then 12.
 *
 * A class with thirteen methods is a room with thirteen people in it who have
 * been told they are one person. Nothing inside can be named, moved, or
 * replaced on its own, and the reason given is always that they all touch the
 * same state — which is the definition of the problem rather than a defence of
 * it.
 *
 * Constructors and accessors are not counted: a constructor is assembly and an
 * accessor is a field with manners. Report-only under `standard` and 12 under
 * `strict`, so the classes this emits are the ones already at or over that
 * ceiling.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading, SignalReadings } from "../../doctor-signal.js";
import {
  evidenceAt,
  isProductionModule,
  lineOf,
  ts,
  visitNodes,
  type DoctorModule,
} from "../scanners/typescript-program.js";

/** The count `strict` refuses, which is also the count worth reporting. */
const CEILING = 12;

function methodCount(node: ts.ClassDeclaration): number {
  return node.members.filter((member) => ts.isMethodDeclaration(member)).length;
}

function measureClasses(module: DoctorModule, readings: Map<string, SignalReading>): void {
  visitNodes(module.source, (node) => {
    if (!ts.isClassDeclaration(node)) return;
    const methods = methodCount(node);
    if (methods <= CEILING) return;
    const name = node.name === undefined ? "anonymous class" : node.name.text;
    readings.set(`${module.path}:${lineOf(module, node)} ${name}`, {
      value: methods,
      evidence: [evidenceAt(module, node, `${methods} methods`)],
    });
  });
}

function countGodClasses(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const module of context.program().modules) {
    if (!isProductionModule(module.path)) continue;
    measureClasses(module, readings);
  }
  return readings;
}

export const godClassesSignal: DoctorSignal = {
  id: "god-classes",
  issue: "enmeshment",
  question: "Does any class carry more methods than the profile's ceiling?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: CEILING },
  sentence: "Ask the file what it does and it says “stuff.” Ask the function and it says “everything.”",
  run: (context) => Promise.resolve(countGodClasses(context)),
};
