/**
 * The literal words a renderer puts in front of somebody.
 *
 * Every seam where a string literal becomes text a customer reads or a screen
 * reader announces: JSX text, a JSX child expression, a visible or accessible
 * prop (`label`, `title`, `aria-label`, `placeholder`, …), a copy-shaped
 * property in an object literal (`label`, `title`, `message`, …), the first
 * argument of a `toast(…)` call, and a value a function returns. A branch —
 * `cond ? "a" : "b"`, `a ?? "b"`, `a || "b"`, `"a" + b` — is followed into each
 * side, so a fallback string is found where it hides.
 *
 * Not every literal at those seams is copy. A copy key (`page.title`), a
 * lowercase data token (`primary`), a code in capitals (`NOT_FOUND`), a URL or
 * a path, and anything without a letter in it are what a renderer passes
 * around, not what it says. `isHardcodedCopy` is that filter.
 */

import { ts, visitNodes } from "./typescript-program.js";

const VISIBLE_PROPS = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "aria-roledescription",
  "aria-valuetext",
  "description",
  "emptyMessage",
  "heading",
  "label",
  "message",
  "placeholder",
  "title",
]);

const COPY_PROPERTIES = new Set(["description", "heading", "label", "message", "title"]);

const TOAST = "toast";
const TOAST_METHODS = new Set(["custom", "error", "info", "loading", "message", "success", "warn", "warning"]);

const BRANCH_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

const COPY_KEY = /^[a-z][A-Za-z0-9_]*(?:[.-][A-Za-z0-9_]+)+$/;
const LOWERCASE_TOKEN = /^[a-z][A-Za-z0-9_]*$/;
const LOWERCASE_FRAGMENT = /^[^A-Za-z]*[a-z]+[^A-Za-z]*$/;
const CODE_TOKEN = /^[A-Z][A-Z0-9_]{2,}$/;
const URL_OR_PATH = /^(?:https?:\/\/|mailto:|\/|\.\/|\.\.\/|#)/;
const LETTER = /[A-Za-z]/;

/** One literal at a seam: the node it sits on, its text, and which seam. */
export type CopySpan = {
  readonly node: ts.Node;
  readonly text: string;
  readonly seam: string;
};

function literalText(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (!ts.isTemplateExpression(node)) return undefined;
  return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("");
}

function branchedSpans(node: ts.Expression | undefined, seam: string): readonly CopySpan[] {
  if (node === undefined) return [];
  const text = literalText(node);
  if (text !== undefined) return [{ node, text, seam }];
  if (ts.isParenthesizedExpression(node)) {
    return branchedSpans(node.expression, seam);
  }
  if (ts.isConditionalExpression(node)) {
    return [...branchedSpans(node.whenTrue, seam), ...branchedSpans(node.whenFalse, seam)];
  }
  if (!ts.isBinaryExpression(node)) return [];
  if (!BRANCH_OPERATORS.has(node.operatorToken.kind)) return [];
  return [...branchedSpans(node.left, seam), ...branchedSpans(node.right, seam)];
}

function jsxAttributeSpans(node: ts.JsxAttribute): readonly CopySpan[] {
  const name = node.name.getText();
  if (!VISIBLE_PROPS.has(name)) return [];
  const value = node.initializer;
  const seam = `${name} prop`;
  if (value === undefined) return [];
  if (ts.isStringLiteral(value)) return [{ node: value, text: value.text, seam }];
  return ts.isJsxExpression(value) ? branchedSpans(value.expression, seam) : [];
}

function isJsxChild(node: ts.JsxExpression): boolean {
  return ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent);
}

function jsxSpans(node: ts.Node): readonly CopySpan[] {
  if (ts.isJsxText(node)) {
    const text = node.getText();
    return LETTER.test(text) ? [{ node, text, seam: "JSX text" }] : [];
  }
  if (ts.isJsxExpression(node) && isJsxChild(node)) {
    return branchedSpans(node.expression, "JSX text");
  }
  return ts.isJsxAttribute(node) ? jsxAttributeSpans(node) : [];
}

function isToastCall(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) return callee.text === TOAST;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === TOAST &&
    TOAST_METHODS.has(callee.name.text)
  );
}

function propertySpans(node: ts.PropertyAssignment): readonly CopySpan[] {
  const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
  const text = literalText(node.initializer);
  if (name === undefined || text === undefined) return [];
  if (!COPY_PROPERTIES.has(name)) return [];
  return [{ node: node.initializer, text, seam: "property" }];
}

function codeSpans(node: ts.Node): readonly CopySpan[] {
  if (ts.isPropertyAssignment(node)) return propertySpans(node);
  if (ts.isCallExpression(node) && isToastCall(node.expression)) {
    const first = node.arguments[0];
    const text = literalText(first);
    return first === undefined || text === undefined ? [] : [{ node: first, text, seam: "toast" }];
  }
  if (ts.isReturnStatement(node)) return branchedSpans(node.expression, "return");
  if (!ts.isArrowFunction(node) || ts.isBlock(node.body)) return [];
  return branchedSpans(node.body, "return");
}

/** Every literal at a seam where copy can be introduced, in source order. */
export function renderedCopySpans(source: ts.SourceFile): readonly CopySpan[] {
  const spans: CopySpan[] = [];
  visitNodes(source, (node) => {
    spans.push(...jsxSpans(node), ...codeSpans(node));
  });
  return spans;
}

/** True when the literal is words for a person rather than data for code. */
export function isHardcodedCopy(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!LETTER.test(normalized)) return false;
  if (COPY_KEY.test(normalized)) return false;
  if (LOWERCASE_TOKEN.test(normalized)) return false;
  if (LOWERCASE_FRAGMENT.test(normalized)) return false;
  if (CODE_TOKEN.test(normalized)) return false;
  return !URL_OR_PATH.test(normalized);
}
