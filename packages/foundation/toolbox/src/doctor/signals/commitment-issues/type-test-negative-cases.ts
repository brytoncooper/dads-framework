/**
 * Negative type tests per package: a floor.
 *
 * A type test that only asserts what compiles proves half of a contract. The
 * other half is what must *not* compile, and in a `type-tests/` directory that
 * is written as an expect-error comment above the authoring mistake the type
 * is supposed to reject. Those are the assertions that catch a type
 * accidentally widening in a refactor, and they are also the assertions a
 * refactor is most tempted to delete, because deleting one always makes the
 * type-check pass.
 *
 * Keyed per package so a package cannot lose its negative cases behind another
 * package's gain.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalEvidence,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import { TS_EXPECT_ERROR_MARK } from "../../hatch-names.js";
import { ts } from "../scanners/typescript-program.js";

const TYPE_TEST = /^(packages\/(?:[^/]+\/)+?)type-tests\/.+\.tsx?$/;

export function countNegativeCases(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  const roots = context.packages().map((owner) => owner.root);
  for (const path of context.files()) {
    const prefix = TYPE_TEST.exec(path)?.[1];
    if (prefix === undefined) continue;
    const owner =
      roots
        .filter((root) => path.startsWith(`${root}/`))
        .sort((left, right) => right.length - left.length)[0] ??
      prefix.slice(0, -1);
    const source = ts.createSourceFile(
      path,
      context.read(path),
      ts.ScriptTarget.Latest,
    );
    const found =
      countExpectError(source) + countVitestNegativeAssertions(source);
    const known = readings.get(owner);
    const evidence: SignalEvidence[] = [...(known?.evidence ?? []), { path }];
    readings.set(owner, { value: (known?.value ?? 0) + found, evidence });
  }
  return readings;
}

function countExpectError(source: ts.SourceFile): number {
  const directives = new Set<number>();
  function visit(node: ts.Node): void {
    const ranges = ts.getLeadingCommentRanges(source.text, node.pos) ?? [];
    for (const { pos, end } of ranges) {
      const comment = source.text.slice(pos + 2, end).trimStart();
      if (comment.startsWith(TS_EXPECT_ERROR_MARK)) directives.add(pos);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return directives.size;
}

function countVitestNegativeAssertions(source: ts.SourceFile): number {
  const names = new Set(source.statements.flatMap(vitestMatchers));
  let count = 0;
  function visit(node: ts.Node): void {
    if (isNegativeAssertion(node, names)) count += 1;
    ts.forEachChild(node, visit);
  }
  visit(source);
  return count;
}

function vitestMatchers(statement: ts.Statement): readonly string[] {
  if (
    !ts.isImportDeclaration(statement) ||
    !ts.isStringLiteral(statement.moduleSpecifier) ||
    statement.moduleSpecifier.text !== "vitest"
  )
    return [];
  const bindings = statement.importClause?.namedBindings;
  if (bindings === undefined || !ts.isNamedImports(bindings)) return [];
  return bindings.elements
    .filter(
      (entry) => (entry.propertyName ?? entry.name).text === "expectTypeOf",
    )
    .map((entry) => entry.name.text);
}

function isNegativeAssertion(
  node: ts.Node,
  names: ReadonlySet<string>,
): boolean {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression)
  )
    return false;
  const matcher = node.expression;
  if (matcher.name.text !== "toExtend" && matcher.name.text !== "toEqualTypeOf")
    return false;
  const negated = matcher.expression;
  if (!ts.isPropertyAccessExpression(negated) || negated.name.text !== "not")
    return false;
  const call = negated.expression;
  return (
    ts.isCallExpression(call) &&
    ts.isIdentifier(call.expression) &&
    names.has(call.expression.text)
  );
}

export const typeTestNegativeCasesSignal: DoctorSignal = {
  id: "type-test-negative-cases",
  issue: "commitment-issues",
  question:
    "Has any package's count of negative type tests fallen below its recorded floor?",
  reads: "text",
  unit: "count",
  direction: "floor",
  thresholds: { standard: null, strict: null },
  sentence: "Zero denial cases. They said “lgtm.” You still feel alone.",
  measure: "typeTestNegativeCases",
  run: (context) => Promise.resolve(countNegativeCases(context)),
};
