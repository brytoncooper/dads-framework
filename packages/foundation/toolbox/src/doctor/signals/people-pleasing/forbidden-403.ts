/**
 * A 403 anywhere a route can reach: ceiling 0.
 *
 * 403 tells a caller that the thing exists and they may not have it. That is a
 * sentence about the family's trampoline, delivered to a stranger, and no
 * amount of politeness in the body takes it back. Dad's answer is 404: absence
 * and denial look the same from outside, so a caller with no relationship
 * learns nothing at all.
 *
 * The reading starts at declared route modules and follows their local
 * dependencies, including delegated handlers and re-exports. Independent
 * protocol mounts do not enter the scan unless a route reaches them.
 * Equality comparisons observe a status rather than emit it. Without any
 * declared blueprints the signal is unmeasured.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalEvidence, SignalReading } from "../../doctor-signal.js";
import type { GraphPackage } from "../scanners/package-graph.js";
import { readRouteModel } from "../scanners/route-model.js";
import { resolveRelativeImport, ts } from "../scanners/typescript-program.js";

const EQUALITY_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

function isStatusComparison(node: ts.NumericLiteral): boolean {
  let expression: ts.Expression = node;
  while (ts.isParenthesizedExpression(expression.parent)) {
    expression = expression.parent;
  }
  const parent = expression.parent;
  return ts.isBinaryExpression(parent) && EQUALITY_OPERATORS.has(parent.operatorToken.kind);
}

function forbiddenLinesIn(context: DoctorContext, path: string): readonly SignalEvidence[] {
  const source = ts.createSourceFile(path, context.read(path), ts.ScriptTarget.Latest, true);
  const lines = new Set<number>();
  function visit(node: ts.Node): void {
    if (ts.isNumericLiteral(node) && Number(node.text) === 403 && !isStatusComparison(node)) {
      lines.add(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return Array.from(lines, (line) => ({ path, line, name: "403" }));
}

function reachableRouteSources(declared: GraphPackage, routePaths: readonly string[]): ReadonlySet<string> {
  const sources = new Set(declared.sources);
  const dependencies = new Map<string, string[]>();
  for (const entry of declared.imports) {
    const target = resolveRelativeImport(entry.path, entry.specifier).find((candidate) => sources.has(candidate));
    if (target === undefined) continue;
    const targets = dependencies.get(entry.path) ?? [];
    targets.push(target);
    dependencies.set(entry.path, targets);
  }

  const reachable = new Set(routePaths);
  for (const path of reachable) {
    for (const dependency of dependencies.get(path) ?? []) {
      reachable.add(dependency);
    }
  }
  return reachable;
}

function countForbidden(context: DoctorContext) {
  const readings = new Map<string, SignalReading>();
  const routes = readRouteModel(context);
  for (const declared of routes.packagesWithRoutes) {
    const paths = routes.operations
      .filter((operation) => operation.packageName === declared.name)
      .map((operation) => operation.path);
    const evidence = Array.from(reachableRouteSources(declared, paths)).flatMap((path) =>
      forbiddenLinesIn(context, path),
    );
    readings.set(declared.name, { value: evidence.length, evidence });
  }
  return readings;
}

export const forbidden403Signal: DoctorSignal = {
  id: "forbidden-403",
  issue: "people-pleasing",
  question: "Does any route return 403?",
  reads: "routes",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "Existence is not a prize you owe a stranger. Dad said just 404.",
  run: (context) => Promise.resolve(countForbidden(context)),
};
