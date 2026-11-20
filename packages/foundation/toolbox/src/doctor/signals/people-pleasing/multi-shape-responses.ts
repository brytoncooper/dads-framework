/**
 * A response type that is a union of shapes: ceiling 0.
 *
 * A union output is two contracts sharing a name. Every consumer has to
 * discriminate before it can read a field, every client generator emits a
 * type nobody wants to hold, and the second shape was added because one caller
 * asked rather than because the route changed what it does. The cure is not a
 * discriminator. It is a second route.
 *
 * The subject is a declared output type — a `type` whose name says response or
 * output — and the reading is whether it is a union of more than one shape. A
 * union with `undefined` or `null` is not counted: that is one shape and its
 * absence, which is a different conversation. The handler half of the
 * companion's question belongs to the route model, which reads the blueprints
 * rather than the types.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import {
  evidenceAt,
  exportedStatements,
  ts,
  type DoctorModule,
} from "../scanners/typescript-program.js";

const OUTPUT_NAME = /(?:response|output)/i;
const ABSENCE = new Set([
  ts.SyntaxKind.UndefinedKeyword,
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.VoidKeyword,
  ts.SyntaxKind.NeverKeyword,
]);

/** How many shapes a type offers, counting an absence as none. */
function shapeCount(type: ts.TypeNode): number {
  if (!ts.isUnionTypeNode(type)) return 1;
  return type.types.filter((member) => !ABSENCE.has(member.kind)).length;
}

function readOutputShapes(
  module: DoctorModule,
  readings: Map<string, SignalReading>,
): void {
  for (const statement of exportedStatements(module)) {
    if (!ts.isTypeAliasDeclaration(statement)) continue;
    const name = statement.name.text;
    if (!OUTPUT_NAME.test(name)) continue;
    const shapes = shapeCount(statement.type);
    readings.set(`${module.path} ${name}`, {
      value: shapes > 1 ? shapes : 0,
      evidence: [evidenceAt(module, statement, name)],
    });
  }
}

function countMultiShapeResponses(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const module of context.program().modules) {
    readOutputShapes(module, readings);
  }
  return readings;
}

export const multiShapeResponsesSignal: DoctorSignal = {
  id: "multi-shape-responses",
  issue: "people-pleasing",
  question:
    "Is a route's output a union, or does its handler return more than one shape?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence:
    "You grow a second response shape, then a third. Nobody loves you more. They just know you’ll fold.",
  run: (context) => Promise.resolve(countMultiShapeResponses(context)),
};
