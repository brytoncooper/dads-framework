/**
 * A boundary read that reached a typed value without being parsed: report,
 * then ceiling 0. A heuristic, and the companion says so.
 *
 * The failure this looks for is not "somebody called `JSON.parse`". It is a
 * value arriving from outside the program — a file, the environment, a request
 * body — and being given a type on the way in, with nothing between the read
 * and the type that checked the value was that shape. The compiler then
 * believes the annotation, and every reader after it does too.
 *
 * The proxy the companion names is "the result reaches a typed position with
 * no parse call between them", and *reaches* is read strictly: the boundary
 * read has to be the whole of what lands in the typed position — the
 * initializer of an annotated declaration, or the expression a function with a
 * declared return type returns — allowing only the wrappers that hide it
 * without changing it, `await`, parentheses, and an assertion. A read that is
 * one argument inside a larger expression has been transformed by whatever
 * surrounds it, and a parse call in that position is the parse this asks for.
 *
 * Two further narrowings keep the proxy honest. The typed position must be a
 * shape somebody named, not `string`: reading a file as text and calling it
 * text is not a claim anybody could have checked, and `unknown` is the honest
 * spelling that forces the parse at the next step. And tests are not measured,
 * because a test builds the value it then reads.
 *
 * It is report-only under `standard` because it is a heuristic, and it earns
 * its ceiling in `strict` only where the corpus shows it quiet.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import {
  addFinding,
  evidenceAt,
  isProductionModule,
  ts,
  visitNodes,
  type DoctorModule,
} from "../scanners/typescript-program.js";

const FILE_READS = new Set(["readFileSync", "readFile"]);
const REQUEST_NAMES = new Set(["request", "req"]);

function calleeName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (!ts.isPropertyAccessExpression(expression)) return "";
  const receiver = ts.isIdentifier(expression.expression)
    ? expression.expression.text
    : "";
  return `${receiver}.${expression.name.text}`;
}

function isEnvironmentRead(node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false;
  const receiver = ts.isIdentifier(node.expression) ? node.expression.text : "";
  return receiver === "process" && node.name.text === "env";
}

function isRequestBody(node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false;
  const receiver = ts.isIdentifier(node.expression) ? node.expression.text : "";
  return node.name.text === "body" && REQUEST_NAMES.has(receiver);
}

function isBoundaryRead(node: ts.Node): boolean {
  if (isEnvironmentRead(node) || isRequestBody(node)) return true;
  if (!ts.isCallExpression(node)) return false;
  const name = calleeName(node.expression);
  return name === "JSON.parse" || FILE_READS.has(name);
}

/** What lands in the position, with the wrappers that only hide it removed. */
function landing(expression: ts.Expression): ts.Expression {
  if (ts.isAwaitExpression(expression)) return landing(expression.expression);
  if (ts.isParenthesizedExpression(expression)) {
    return landing(expression.expression);
  }
  if (ts.isAsExpression(expression)) return landing(expression.expression);
  if (ts.isNonNullExpression(expression)) return landing(expression.expression);
  return expression;
}

/**
 * A shape somebody claimed the value has: a named type or a type literal.
 * `unknown` claims nothing and is the honest spelling of a boundary read;
 * `string`, `number`, and `boolean` claim nothing a parser would have checked,
 * because reading a file as text is text.
 */
function isClaimedShape(type: ts.TypeNode): boolean {
  return ts.isTypeReferenceNode(type) || ts.isTypeLiteralNode(type);
}

function isUnparsed(expression: ts.Expression | undefined): boolean {
  return expression !== undefined && isBoundaryRead(landing(expression));
}

function declaredReturnType(node: ts.Node): ts.TypeNode | undefined {
  let current: ts.Node = node.parent;
  while (!ts.isSourceFile(current)) {
    if (ts.isFunctionLike(current)) return current.type;
    current = current.parent;
  }
  return undefined;
}

/** What a node is doing wrong, when it is doing something wrong. */
function unparsedTarget(node: ts.Node): string | undefined {
  if (ts.isVariableDeclaration(node)) {
    if (node.type === undefined || !isClaimedShape(node.type)) return undefined;
    return isUnparsed(node.initializer) ? "read into a typed value" : undefined;
  }
  if (!ts.isReturnStatement(node)) return undefined;
  const returned = declaredReturnType(node);
  if (returned === undefined || !isClaimedShape(returned)) return undefined;
  return isUnparsed(node.expression) ? "read returned as typed" : undefined;
}

function collectUnparsedReads(
  module: DoctorModule,
  readings: Map<string, SignalReading>,
): void {
  visitNodes(module.source, (node) => {
    const target = unparsedTarget(node);
    if (target === undefined) return;
    addFinding(readings, module.packageRoot, evidenceAt(module, node, target));
  });
}

function countUnparsedReads(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const module of context.program().modules) {
    if (!isProductionModule(module.path)) continue;
    collectUnparsedReads(module, readings);
  }
  return readings;
}

export const unparsedBoundaryReadsSignal: DoctorSignal = {
  id: "unparsed-boundary-reads",
  issue: "disorganized-attachment",
  question:
    "Is the result of a boundary read — `JSON.parse`, `process.env`, a file read, a request body — used without passing through a parser in the same function? (heuristic)",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: 0 },
  sentence:
    "Sometimes you validate. Sometimes you trust. Sometimes you wake up to a production incident and cannot remember which version of you shipped.",
  run: (context) => Promise.resolve(countUnparsedReads(context)),
};
