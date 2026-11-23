/**
 * `jsonb` columns that do not name what they hold: ceiling 0.
 *
 * A `jsonb` column is the one column the database will not describe: it takes
 * any JSON at all, so the only statement of its shape is the `.$type<T>()` on
 * the column. When `T` is a named type — imported, or declared in the module —
 * every writer and reader follows it to one definition, and changing the shape
 * is an edit the compiler checks everywhere. When `T` is `unknown`, a
 * `Record<…>`, a primitive, or a shape spelled inline, nothing names it, so
 * nothing stops two writers disagreeing about it. And with no `.$type` at all
 * the column is a bag.
 *
 * A column is a `jsonb("name")` call inside a `…Table("name", …)` call. It
 * names its schema when the type argument, after peeling `readonly`, parentheses
 * and `[]`, is a reference whose head the module imports or declares. `Record`
 * and `Array` are never imported, so they fail the same test a typo does.
 *
 * The key is the module; each column found wanting is evidence, named
 * `table.column`. Modules that declare `jsonb` columns are keys, zeros
 * included.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalEvidence, SignalReading, SignalReadings } from "../../doctor-signal.js";
import {
  evidenceAt,
  isProductionModule,
  leftmostTypeName,
  ts,
  visitNodes,
  type DoctorModule,
} from "../scanners/typescript-program.js";

const COLUMN_BUILDER = "jsonb";
const TABLE_BUILDER = /Table$/;
const TYPE_METHOD = "$type";

function addImportedNames(statement: ts.ImportDeclaration, names: Set<string>): void {
  const clause = statement.importClause;
  if (clause === undefined) return;
  if (clause.name !== undefined) names.add(clause.name.text);
  const bindings = clause.namedBindings;
  if (bindings === undefined) return;
  if (ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
  else for (const element of bindings.elements) names.add(element.name.text);
}

function isNamedDeclaration(
  statement: ts.Statement,
): statement is ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.EnumDeclaration | ts.ClassDeclaration {
  return (
    ts.isTypeAliasDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isClassDeclaration(statement)
  );
}

/** Every name a module can use as a type without spelling its shape. */
function declaredTypeNames(source: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) addImportedNames(statement, names);
    if (isNamedDeclaration(statement) && statement.name !== undefined) {
      names.add(statement.name.text);
    }
  }
  return names;
}

/** True when a type argument names a schema the module can see. */
export function namesItsSchema(node: ts.TypeNode | undefined, declared: ReadonlySet<string>): boolean {
  if (node === undefined) return false;
  if (ts.isParenthesizedTypeNode(node)) {
    return namesItsSchema(node.type, declared);
  }
  if (ts.isTypeOperatorNode(node)) {
    return node.operator === ts.SyntaxKind.ReadonlyKeyword && namesItsSchema(node.type, declared);
  }
  if (ts.isArrayTypeNode(node)) {
    return namesItsSchema(node.elementType, declared);
  }
  return ts.isTypeReferenceNode(node) && declared.has(leftmostTypeName(node.typeName));
}

function firstStringArgument(call: ts.CallExpression): string | undefined {
  const first = call.arguments[0];
  return first !== undefined && ts.isStringLiteralLike(first) ? first.text : undefined;
}

function isColumnCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === COLUMN_BUILDER &&
    firstStringArgument(node) !== undefined
  );
}

/** The SQL name of the table call a column sits inside. */
function enclosingTable(node: ts.Node): string {
  for (let current = node.parent; ; current = current.parent) {
    if (ts.isSourceFile(current)) return "?";
    if (!ts.isCallExpression(current)) continue;
    if (!ts.isIdentifier(current.expression)) continue;
    if (!TABLE_BUILDER.test(current.expression.text)) continue;
    const name = firstStringArgument(current);
    if (name !== undefined) return name;
  }
}

/** The type argument of a `.$type<…>()` chained onto a column, if any. */
function chainedType(column: ts.CallExpression): ts.TypeNode | undefined {
  let found: ts.TypeNode | undefined;
  let current: ts.Node = column;
  for (;;) {
    const access = current.parent;
    if (!ts.isPropertyAccessExpression(access)) return found;
    const call = access.parent;
    if (!ts.isCallExpression(call) || call.expression !== access) return found;
    if (access.name.text === TYPE_METHOD) found = call.typeArguments?.[0];
    current = call;
  }
}

function unnamedColumns(module: DoctorModule): readonly SignalEvidence[] | undefined {
  if (!module.source.text.includes(COLUMN_BUILDER)) return undefined;
  const declared = declaredTypeNames(module.source);
  let columns = 0;
  const unnamed: SignalEvidence[] = [];
  visitNodes(module.source, (node) => {
    if (!isColumnCall(node)) return;
    columns += 1;
    if (namesItsSchema(chainedType(node), declared)) return;
    const name = `${enclosingTable(node)}.${firstStringArgument(node) ?? ""}`;
    unnamed.push(evidenceAt(module, node, name));
  });
  return columns === 0 ? undefined : unnamed;
}

function countUnnamedColumns(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const module of context.program().modules) {
    if (!isProductionModule(module.path)) continue;
    const unnamed = unnamedColumns(module);
    if (unnamed === undefined) continue;
    readings.set(module.path, { value: unnamed.length, evidence: unnamed });
  }
  return readings;
}

export const jsonbWithoutSchemaSignal: DoctorSignal = {
  id: "jsonb-without-schema",
  issue: "disorganized-attachment",
  question:
    "Does a `jsonb` column carry no `.$type<T>()`, or one whose type is not a named, imported or declared type?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "Sometimes you validate. Sometimes you trust.",
  run: (context) => Promise.resolve(countUnnamedColumns(context)),
};
