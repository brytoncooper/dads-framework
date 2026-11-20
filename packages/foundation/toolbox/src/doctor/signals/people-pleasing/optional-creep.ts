/**
 * Optional fields in an output schema: report, then 50%.
 *
 * Every optional output field is a promise not made. The caller has to branch,
 * the client generator has to widen, and nobody can say from the contract
 * whether the field is absent because the row had nothing or because the
 * handler forgot. One is a modelling decision; half the schema is a habit of
 * adding rather than deciding.
 *
 * The subject is a declared output — a type or a `z.object({…})` whose name
 * says response or output — and the reading is the share of its fields that
 * are optional. Both spellings of optional are read: the `?` on a property and
 * the `.optional()` or `.nullish()` on a schema field.
 *
 * Report-only under `standard` and 50% under `strict`, so the schemas this
 * emits are the ones already at or over that share.
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

/** The share `strict` refuses, which is also the share worth reporting. */
const CEILING = 50;
const OUTPUT_NAME = /(?:response|output)/i;
const OPTIONAL_CALLS = /\.(?:optional|nullish)\(/;

type FieldTally = {
  readonly fields: number;
  readonly optional: number;
};

function tallyTypeLiteral(type: ts.TypeLiteralNode): FieldTally {
  const properties = type.members.flatMap((member) =>
    ts.isPropertySignature(member) ? [member] : [],
  );
  return {
    fields: properties.length,
    optional: properties.filter((member) => member.questionToken !== undefined)
      .length,
  };
}

function tallySchemaObject(
  object: ts.ObjectLiteralExpression,
  module: DoctorModule,
): FieldTally {
  const properties = object.properties.flatMap((property) =>
    ts.isPropertyAssignment(property) ? [property] : [],
  );
  return {
    fields: properties.length,
    optional: properties.filter((property) =>
      OPTIONAL_CALLS.test(property.initializer.getText(module.source)),
    ).length,
  };
}

/** The object literal a `z.object({…})` call describes. */
function optionalSchemaObject(
  node: ts.Node,
): ts.ObjectLiteralExpression | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  if (callee.name.text !== "object") return undefined;
  const argument = node.arguments[0];
  return argument !== undefined && ts.isObjectLiteralExpression(argument)
    ? argument
    : undefined;
}

function tallyOf(
  statement: ts.Statement,
  module: DoctorModule,
): FieldTally | undefined {
  if (ts.isTypeAliasDeclaration(statement)) {
    return ts.isTypeLiteralNode(statement.type)
      ? tallyTypeLiteral(statement.type)
      : undefined;
  }
  if (!ts.isVariableStatement(statement)) return undefined;
  const initializer = statement.declarationList.declarations[0]?.initializer;
  const object =
    initializer === undefined ? undefined : optionalSchemaObject(initializer);
  return object === undefined ? undefined : tallySchemaObject(object, module);
}

function outputName(statement: ts.Statement): string | undefined {
  if (ts.isTypeAliasDeclaration(statement)) return statement.name.text;
  if (!ts.isVariableStatement(statement)) return undefined;
  const declared = statement.declarationList.declarations[0]?.name;
  return declared !== undefined && ts.isIdentifier(declared)
    ? declared.text
    : undefined;
}

function readOptionalShares(
  module: DoctorModule,
  readings: Map<string, SignalReading>,
): void {
  for (const statement of exportedStatements(module)) {
    const name = outputName(statement);
    if (name === undefined || !OUTPUT_NAME.test(name)) continue;
    const tally = tallyOf(statement, module);
    if (tally === undefined || tally.fields === 0) continue;
    const share = Math.round((tally.optional / tally.fields) * 100);
    if (share < CEILING) continue;
    readings.set(`${module.path} ${name}`, {
      value: share,
      evidence: [evidenceAt(module, statement, name)],
    });
  }
}

function countOptionalCreep(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const module of context.program().modules) {
    readOptionalShares(module, readings);
  }
  return readings;
}

export const optionalCreepSignal: DoctorSignal = {
  id: "optional-creep",
  issue: "people-pleasing",
  question:
    "Is the share of optional fields in output schemas above the profile's threshold?",
  reads: "typescript",
  unit: "percent",
  direction: "ceiling",
  thresholds: { standard: null, strict: CEILING },
  sentence: "You add a field because one client sounded disappointed.",
  run: (context) => Promise.resolve(countOptionalCreep(context)),
};
