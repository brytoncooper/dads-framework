/**
 * The same type, declared again in another package: ceiling 0.
 *
 * A copied type is the cheapest way to avoid depending on somebody, and the
 * most expensive thing to undo. Both copies drift, both are right about
 * something, and the thread asking which one is canonical outlives everyone on
 * it. The name being the same in two packages is what makes it a copy rather
 * than a coincidence, and the fields being the same is what makes it the same
 * type rather than two ideas that share a word.
 *
 * The reading is the number of *extra* packages declaring a name with an
 * identical field set, so a type declared once reads zero and a type declared
 * in two packages reads one. Only exported shapes are compared: a type nobody
 * can import was not copied from anywhere.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalEvidence, SignalReading, SignalReadings } from "../../doctor-signal.js";
import { evidenceAt, exportedStatements, ts, type DoctorModule } from "../scanners/typescript-program.js";

/** One exported shape: where it is, which package owns it, and its fields. */
type DeclaredShape = {
  readonly packageRoot: string;
  readonly fields: string;
  readonly evidence: SignalEvidence;
};

/** The property and method names a shape declares, sorted and joined. */
function fieldSignature(members: readonly ts.TypeElement[]): string {
  return members
    .flatMap((member) =>
      (ts.isPropertySignature(member) || ts.isMethodSignature(member)) && ts.isIdentifier(member.name)
        ? [member.name.text]
        : [],
    )
    .sort()
    .join(",");
}

function shapeOf(statement: ts.Statement): readonly ts.TypeElement[] | null {
  if (ts.isInterfaceDeclaration(statement)) return statement.members;
  if (ts.isTypeAliasDeclaration(statement) && ts.isTypeLiteralNode(statement.type)) {
    return statement.type.members;
  }
  return null;
}

function shapeName(statement: ts.Statement): string | undefined {
  if (ts.isInterfaceDeclaration(statement)) return statement.name.text;
  if (ts.isTypeAliasDeclaration(statement)) return statement.name.text;
  return undefined;
}

function declaredShapes(module: DoctorModule, found: Map<string, DeclaredShape[]>): void {
  for (const statement of exportedStatements(module)) {
    const members = shapeOf(statement);
    const name = shapeName(statement);
    if (members === null || members.length === 0) continue;
    if (name === undefined) continue;
    const shapes = found.get(name) ?? [];
    shapes.push({
      packageRoot: module.packageRoot,
      fields: fieldSignature(members),
      evidence: evidenceAt(module, statement, name),
    });
    found.set(name, shapes);
  }
}

/** The largest set of distinct packages that declare one name identically. */
function widestCopy(shapes: readonly DeclaredShape[]): readonly DeclaredShape[] {
  const byFields = new Map<string, DeclaredShape[]>();
  for (const shape of shapes) {
    const matching = byFields.get(shape.fields) ?? [];
    if (matching.every((other) => other.packageRoot !== shape.packageRoot)) {
      matching.push(shape);
    }
    byFields.set(shape.fields, matching);
  }
  return [...byFields.values()].reduce((widest, group) => (group.length > widest.length ? group : widest), []);
}

function countCopiedTypes(context: DoctorContext): SignalReadings {
  const found = new Map<string, DeclaredShape[]>();
  for (const module of context.program().modules) {
    declaredShapes(module, found);
  }
  const readings = new Map<string, SignalReading>();
  for (const [name, shapes] of found) {
    const copies = widestCopy(shapes);
    readings.set(name, {
      value: copies.length - 1,
      evidence: copies.map((shape) => shape.evidence),
    });
  }
  return readings;
}

export const copiedTypesSignal: DoctorSignal = {
  id: "copied-types",
  issue: "anxious-attachment",
  question: "Is the same exported type name declared in more than one package with a similar shape?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "You copied the type into six packages so nobody could leave.",
  run: (context) => Promise.resolve(countCopiedTypes(context)),
};
