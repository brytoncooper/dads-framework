/**
 * A function over any of the four ceilings: ceiling 0.
 *
 * One function carrying eighty-one statements is not a strong function. The
 * four ceilings are the four ways a function gets that way — too many
 * branches, too many statements, too deeply nested, too many callbacks inside
 * each other — and a function is over this signal when it is over any of them.
 * The reading is therefore how many of the four it exceeds, and the evidence
 * says which, with the number.
 *
 * The ceilings are the ones ESLint already holds this repository to, measured
 * the same way: complexity and depth within the function's own body, stopping
 * at any function nested inside it, because that one is measured separately;
 * statements as the statements of the body itself; and callback nesting as the
 * chain of functions passed as arguments, wherever it runs.
 *
 * Tests are not measured. A test's arrange-act-assert body is long on purpose
 * and its ceiling is the file one.
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
  functionBodyOf,
  functionName,
  isFunctionNode,
  isProductionModule,
  lineOf,
  ts,
  visitNodes,
  type DoctorModule,
} from "../scanners/typescript-program.js";

const COMPLEXITY_CEILING = 10;
const STATEMENT_CEILING = 20;
const DEPTH_CEILING = 3;
const CALLBACK_CEILING = 2;

const BRANCHES = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.CaseClause,
]);
const NESTING = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.TryStatement,
]);
const LOGICAL = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

type Tally = {
  complexity: number;
  depth: number;
  callbacks: number;
};

function isLogicalBranch(node: ts.Node): boolean {
  return ts.isBinaryExpression(node) && LOGICAL.has(node.operatorToken.kind);
}

/** An `else if` is the same arm of one decision, not a deeper one. */
function deepens(node: ts.Node): boolean {
  if (!NESTING.has(node.kind)) return false;
  if (!ts.isIfStatement(node)) return true;
  const parent = node.parent;
  return !(ts.isIfStatement(parent) && parent.elseStatement === node);
}

function measureOwnBody(node: ts.Node, depth: number, tally: Tally): void {
  node.forEachChild((child) => {
    if (isFunctionNode(child)) return;
    if (BRANCHES.has(child.kind) || isLogicalBranch(child)) {
      tally.complexity += 1;
    }
    const next = deepens(child) ? depth + 1 : depth;
    tally.depth = Math.max(tally.depth, next);
    measureOwnBody(child, next, tally);
  });
}

function isCallbackFunction(node: ts.Node): boolean {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  const parent = node.parent;
  if (!ts.isCallExpression(parent)) return false;
  return parent.arguments.some((argument) => argument === node);
}

function measureCallbacks(node: ts.Node, level: number, tally: Tally): void {
  node.forEachChild((child) => {
    const next = isCallbackFunction(child) ? level + 1 : level;
    tally.callbacks = Math.max(tally.callbacks, next);
    measureCallbacks(child, next, tally);
  });
}

/** Which ceilings this body is over, with the number that put it there. */
function breaches(body: ts.Block): readonly string[] {
  const tally: Tally = { complexity: 1, depth: 0, callbacks: 0 };
  measureOwnBody(body, 0, tally);
  measureCallbacks(body, 0, tally);
  const statements = body.statements.length;
  return [
    tally.complexity > COMPLEXITY_CEILING
      ? `complexity ${tally.complexity}`
      : "",
    statements > STATEMENT_CEILING ? `statements ${statements}` : "",
    tally.depth > DEPTH_CEILING ? `depth ${tally.depth}` : "",
    tally.callbacks > CALLBACK_CEILING ? `callbacks ${tally.callbacks}` : "",
  ].filter((over) => over.length > 0);
}

function measureModule(
  module: DoctorModule,
  readings: Map<string, SignalReading>,
): void {
  visitNodes(module.source, (node) => {
    const body = functionBodyOf(node);
    if (body === undefined) return;
    const over = breaches(body);
    const evidence: SignalEvidence[] = over.map((detail) =>
      evidenceAt(module, node, detail),
    );
    const where = `${module.path}:${lineOf(module, node)}`;
    readings.set(`${where} ${functionName(node)}`, {
      value: over.length,
      evidence,
    });
  });
}

function countFunctionsOverCeiling(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const module of context.program().modules) {
    if (!isProductionModule(module.path)) continue;
    measureModule(module, readings);
  }
  return readings;
}

export const functionsOverCeilingSignal: DoctorSignal = {
  id: "functions-over-ceiling",
  issue: "enmeshment",
  question:
    "Does any production function exceed complexity 10, 20 statements, depth 3, or 2 nested callbacks?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence:
    "One function carrying eighty-one statements is not a strong function. It is the oldest kid doing six jobs because nobody was allowed a job of their own.",
  run: (context) => Promise.resolve(countFunctionsOverCeiling(context)),
};
