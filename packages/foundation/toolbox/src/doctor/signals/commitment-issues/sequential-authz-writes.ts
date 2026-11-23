/**
 * A row and its authorization facts written in two steps: ceiling 0.
 *
 * Insert the row, then write the relationships: two statements, and a crash
 * between them leaves a row nobody can reach, an administrator included,
 * because the tuple that would have let them is the one that never got
 * written. The authorization kit's answer is to state the facts as data
 * (`accessChangesToWrite`) and hand them to the writer, which enqueues them in
 * the insert's own transaction, so there is no moment between the two.
 *
 * `mutations-without-ownership` asks whether a creator records ownership at
 * all. This asks how: a function that inserts a row and, in the same body,
 * either calls `writeRelationships` or pulls it off an object to call later,
 * or calls `.append(` in a module that holds the outbox seam — the method for a
 * fact with no row of its own, which beside an insert runs as its own
 * statement and gives back the window the outbox exists to close.
 *
 * It reads the shape of one function, not the writer behind it: whether the
 * entries reach the transaction is what a test that fails after the enqueue
 * proves. Every production module holding a function that inserts is a key,
 * zeros included.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalEvidence, SignalReading, SignalReadings } from "../../doctor-signal.js";
import {
  containsInScope,
  evidenceAt,
  functionBodyOf,
  functionName,
  isFunctionNode,
  isProductionModule,
  ts,
  visitNodes,
  type DoctorModule,
} from "../scanners/typescript-program.js";

const INSERT = "insert";
const SEQUENTIAL_WRITE = "writeRelationships";
const ROWLESS_APPEND = "append";
const OUTBOX_SEAM = /\bEnqueueAccessChanges\b|\baccessChangesToWrite\b/;
const PROTECTED_TRANSACTIONS = new Set([
  "withProtectedDrizzleTransaction",
  "withProtectedPgTransaction",
  "withProtectedPostgresTransaction",
  "writeWithPermission",
]);

function callsMethod(node: ts.Node, method: string): boolean {
  return (
    ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === method
  );
}

/** True when a function callback executes inside a protected Postgres transaction wrapper. */
function isProtectedTransactionCallback(node: ts.Node): boolean {
  let current: ts.Node = node.parent;
  while (ts.isParenthesizedExpression(current)) {
    current = current.parent;
  }
  if (!ts.isCallExpression(current)) return false;
  const callee = current.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;
  return name !== undefined && PROTECTED_TRANSACTIONS.has(name);
}

/** `const { writeRelationships } = …`, which is the same call, deferred. */
function bindsSequentialWrite(node: ts.Node): boolean {
  if (!ts.isObjectBindingPattern(node)) return false;
  return node.elements.some((element) => {
    const name = element.propertyName ?? element.name;
    return ts.isIdentifier(name) && name.text === SEQUENTIAL_WRITE;
  });
}

/** True when an inserting body also writes the facts as a step of its own. */
function writesInTwoSteps(body: ts.Block, holdsOutbox: boolean, inProtectedTransaction: boolean): boolean {
  return containsInScope(
    body,
    (node) =>
      (!inProtectedTransaction && (callsMethod(node, SEQUENTIAL_WRITE) || bindsSequentialWrite(node))) ||
      (holdsOutbox && callsMethod(node, ROWLESS_APPEND)),
  );
}

type InsertingFunctions = {
  readonly inserting: number;
  readonly twoStep: readonly SignalEvidence[];
};

function readInsertingFunctions(module: DoctorModule): InsertingFunctions {
  const holdsOutbox = OUTBOX_SEAM.test(module.source.text);
  let inserting = 0;
  const twoStep: SignalEvidence[] = [];
  visitNodes(module.source, (node) => {
    if (!isFunctionNode(node)) return;
    const body = functionBodyOf(node);
    if (body === undefined) return;
    if (!containsInScope(body, (child) => callsMethod(child, INSERT))) return;
    inserting += 1;
    if (!writesInTwoSteps(body, holdsOutbox, isProtectedTransactionCallback(node))) return;
    twoStep.push(evidenceAt(module, node, functionName(node)));
  });
  return { inserting, twoStep };
}

function countTwoStepWrites(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const module of context.program().modules) {
    if (!isProductionModule(module.path)) continue;
    if (!module.source.text.includes(INSERT)) continue;
    const found = readInsertingFunctions(module);
    if (found.inserting === 0) continue;
    readings.set(module.path, {
      value: found.twoStep.length,
      evidence: found.twoStep,
    });
  }
  return readings;
}

export const sequentialAuthzWritesSignal: DoctorSignal = {
  id: "sequential-authz-writes",
  issue: "commitment-issues",
  question:
    "Does a function insert a row and write its relationships as a separate step, rather than handing the facts to the insert's transaction?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "You created the row. You did not write the ownership tuple. You said labels make you uncomfortable.",
  run: (context) => Promise.resolve(countTwoStepWrites(context)),
};
