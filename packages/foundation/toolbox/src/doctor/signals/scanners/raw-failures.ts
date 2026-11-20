/**
 * Where a renderer reads a raw failure's words.
 *
 * A failure is anything caught, or anything named like one: a name ending in
 * `error`, `failure`, `exception`, `issue` or `refusal`, a property with such a
 * name, and any value assigned from one. Its `message`, read directly, pulled
 * out by destructuring, or the whole failure passed through `String(…)`, is
 * text written for whoever debugs it — a stack frame, a column name, a vendor's
 * sentence — and none of it was written for the person looking at the screen.
 *
 * The names are a heuristic and say so: a variable called `error` that holds
 * copy is a false positive whose fix is a better name.
 */

import { ts, visitNodes } from "./typescript-program.js";

const FAILURE_NAME = /(?:error|failure|exception|issue|refusal)$/i;
const MESSAGE = "message";
const STRINGIFY = "String";

/** One place a raw failure is read, and how. */
export type FailureSpan = {
  readonly node: ts.Node;
  readonly seam: "raw message" | "destructured message" | "stringified failure";
};

function propertyName(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (!ts.isElementAccessExpression(node)) return undefined;
  const argument = node.argumentExpression;
  return ts.isStringLiteral(argument) ? argument.text : undefined;
}

function isFailure(
  node: ts.Expression,
  bindings: ReadonlySet<string>,
): boolean {
  if (ts.isParenthesizedExpression(node)) {
    return isFailure(node.expression, bindings);
  }
  if (ts.isIdentifier(node)) {
    return bindings.has(node.text) || FAILURE_NAME.test(node.text);
  }
  if (
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  ) {
    return false;
  }
  const name = propertyName(node);
  return (
    (name !== undefined && FAILURE_NAME.test(name)) ||
    isFailure(node.expression, bindings)
  );
}

function recordBinding(node: ts.Node, bindings: Set<string>): void {
  if (ts.isCatchClause(node)) {
    const name = node.variableDeclaration?.name;
    if (name !== undefined && ts.isIdentifier(name)) bindings.add(name.text);
    return;
  }
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
  if (node.initializer !== undefined && isFailure(node.initializer, bindings)) {
    bindings.add(node.name.text);
  }
}

function isMessageRead(node: ts.Node, bindings: ReadonlySet<string>): boolean {
  if (
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  ) {
    return false;
  }
  return propertyName(node) === MESSAGE && isFailure(node.expression, bindings);
}

function isMessageDestructured(
  node: ts.Node,
  bindings: ReadonlySet<string>,
): boolean {
  if (!ts.isVariableDeclaration(node)) return false;
  if (!ts.isObjectBindingPattern(node.name)) return false;
  if (node.initializer === undefined) return false;
  if (!isFailure(node.initializer, bindings)) return false;
  return node.name.elements.some((element) => {
    const name = element.propertyName ?? element.name;
    return ts.isIdentifier(name) && name.text === MESSAGE;
  });
}

function isStringified(node: ts.Node, bindings: ReadonlySet<string>): boolean {
  if (!ts.isCallExpression(node)) return false;
  if (!ts.isIdentifier(node.expression)) return false;
  if (node.expression.text !== STRINGIFY) return false;
  const first = node.arguments[0];
  return first !== undefined && isFailure(first, bindings);
}

function spanAt(
  node: ts.Node,
  bindings: ReadonlySet<string>,
): FailureSpan | undefined {
  if (isMessageRead(node, bindings)) return { node, seam: "raw message" };
  if (isMessageDestructured(node, bindings)) {
    return { node, seam: "destructured message" };
  }
  return isStringified(node, bindings)
    ? { node, seam: "stringified failure" }
    : undefined;
}

/** Every raw failure read in a module, in source order. */
export function rawFailureSpans(source: ts.SourceFile): readonly FailureSpan[] {
  const bindings = new Set<string>();
  const spans: FailureSpan[] = [];
  visitNodes(source, (node) => {
    recordBinding(node, bindings);
    const span = spanAt(node, bindings);
    if (span !== undefined) spans.push(span);
  });
  return spans;
}
