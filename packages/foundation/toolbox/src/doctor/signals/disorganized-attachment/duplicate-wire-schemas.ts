/**
 * Two declarations of one wire shape inside a package: report, then ceiling 0.
 * A heuristic, and the companion says so.
 *
 * The failure is not repetition. It is that a package holds a parsed schema
 * for a shape and a hand-written type for the same shape, so which guarantee
 * applies depends on which one the file in front of you happened to import.
 * One of them will be updated and the other will not, and nothing will fail
 * until the wire disagrees with the type in production.
 *
 * The proxy the companion names is two declarations with identical field-name
 * sets. Both spellings are read: a type literal or an interface, and a
 * `z.object({…})` bound to a name. Three things narrow it to the failure the
 * definition describes — a schema in one module and a type in another. Only
 * exported declarations count, because a wire shape is something a package
 * publishes. Only shapes of at least three fields count, because two-field
 * shapes collide by coincidence often enough to make this a signal nobody
 * believes. And the declarations must sit in different modules: one module
 * holding a shape and a variant of it has made a decision, not a mistake.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalEvidence,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import {
  evidenceAt,
  exportedStatements,
  ts,
  type DoctorModule,
} from "../scanners/typescript-program.js";

/** Below this, two declarations share a field set by accident. */
const MINIMUM_FIELDS = 3;

/** One declared shape: which package holds it, and where it is. */
type DeclaredWireShape = {
  readonly packageRoot: string;
  readonly evidence: SignalEvidence;
};

function nameOf(member: ts.Node): string | undefined {
  if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
    return member.name.text;
  }
  if (ts.isPropertyAssignment(member) && ts.isIdentifier(member.name)) {
    return member.name.text;
  }
  return undefined;
}

function signatureOf(members: readonly ts.Node[]): string | undefined {
  const names = members.flatMap((member) => {
    const name = nameOf(member);
    return name === undefined ? [] : [name];
  });
  return names.length < MINIMUM_FIELDS
    ? undefined
    : [...names].sort().join(",");
}

/** The object literal a `z.object({…})` call describes, when that is what it is. */
function schemaObject(node: ts.Node): ts.ObjectLiteralExpression | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  if (callee.name.text !== "object") return undefined;
  const argument = node.arguments[0];
  return argument !== undefined && ts.isObjectLiteralExpression(argument)
    ? argument
    : undefined;
}

function declaredShape(statement: ts.Statement): string | undefined {
  if (ts.isInterfaceDeclaration(statement)) {
    return signatureOf([...statement.members]);
  }
  if (ts.isTypeAliasDeclaration(statement)) {
    return ts.isTypeLiteralNode(statement.type)
      ? signatureOf([...statement.type.members])
      : undefined;
  }
  if (!ts.isVariableStatement(statement)) return undefined;
  const declared = statement.declarationList.declarations[0];
  const initializer = declared?.initializer;
  const object =
    initializer === undefined ? undefined : schemaObject(initializer);
  return object === undefined ? undefined : signatureOf([...object.properties]);
}

function collectShapes(
  module: DoctorModule,
  shapes: Map<string, DeclaredWireShape[]>,
): void {
  for (const statement of exportedStatements(module)) {
    const signature = declaredShape(statement);
    if (signature === undefined) continue;
    const key = `${module.packageRoot}|${signature}`;
    const found = shapes.get(key) ?? [];
    found.push({
      packageRoot: module.packageRoot,
      evidence: evidenceAt(module, statement, signature),
    });
    shapes.set(key, found);
  }
}

/** True when the declarations sit in more than one module. */
function spansModules(group: readonly DeclaredWireShape[]): boolean {
  return new Set(group.map((shape) => shape.evidence.path)).size > 1;
}

function recordDuplicate(
  readings: Map<string, SignalReading>,
  group: readonly DeclaredWireShape[],
): void {
  const first = group[0];
  if (first === undefined) return;
  const found = readings.get(first.packageRoot);
  const already = found === undefined ? [] : found.evidence;
  readings.set(first.packageRoot, {
    value: (found === undefined ? 0 : found.value) + 1,
    evidence: [...already, ...group.map((shape) => shape.evidence)],
  });
}

function countDuplicateSchemas(context: DoctorContext): SignalReadings {
  const shapes = new Map<string, DeclaredWireShape[]>();
  for (const module of context.program().modules) {
    collectShapes(module, shapes);
  }

  const readings = new Map<string, SignalReading>();
  for (const group of shapes.values()) {
    if (group.length < 2 || !spansModules(group)) continue;
    recordDuplicate(readings, group);
  }
  return readings;
}

export const duplicateWireSchemasSignal: DoctorSignal = {
  id: "duplicate-wire-schemas",
  issue: "disorganized-attachment",
  question: "Do two schemas describe one wire shape? (heuristic)",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: 0 },
  sentence: "Both. In the same file.",
  run: (context) => Promise.resolve(countDuplicateSchemas(context)),
};
