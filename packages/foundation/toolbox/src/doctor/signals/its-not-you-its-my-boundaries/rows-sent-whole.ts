/**
 * Responses that send whatever the row holds: ceiling 0.
 *
 * `{ ...row, createdAt: row.createdAt.toISOString() }`, `return row` and
 * `({ rowVersion: _, ...rest }) => rest` all send every column the table has.
 * The day the table gains a column, so does the API, and nobody decided it
 * should. Written out field by field, a new column reaches a client only when
 * somebody adds it to a mapper, and a schema change never forces a contract
 * change.
 *
 * Response code is a module that declares routes, or one under an `http/`
 * directory. In it, a value counts when it is a row by its name — `row`,
 * `record`, or a name ending in `Row` or `Record` — and it is spread into an
 * object, returned as it is, or handed whole to `ok`, `json`, `created`,
 * `send`, `envelope`, or a schema's `.parse`. An object rest binding counts
 * wherever it appears, because a rest is "everything I did not name", which is
 * the leak spelled the other way round.
 *
 * Syntax cannot tell a row from an object a mapper built, so the reading keys
 * on names and says so: a mapped value called `row` is a false positive whose
 * fix is a better name. Every response module is a key, zeros included.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalEvidence, SignalReading, SignalReadings } from "../../doctor-signal.js";
import { isResponseCode } from "../scanners/response-code.js";
import { evidenceAt, isProductionModule, ts, visitNodes, type DoctorModule } from "../scanners/typescript-program.js";

const ROW_NAME = /^(?:row|record)$|(?:Row|Record)$/;
const RESPONSE_SENDERS = new Set(["ok", "json", "created", "send", "envelope", "parse"]);

/** True for an expression that names a whole row. */
function isRowValue(node: ts.Node | undefined): boolean {
  if (node === undefined) return false;
  if (ts.isParenthesizedExpression(node)) return isRowValue(node.expression);
  if (ts.isIdentifier(node)) return ROW_NAME.test(node.text);
  return ts.isPropertyAccessExpression(node) && ROW_NAME.test(node.name.text);
}

function senderName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}

function isWholeRowSent(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const name = senderName(node);
  return name !== undefined && RESPONSE_SENDERS.has(name) && isRowValue(node.arguments[0]);
}

function isWholeRowReturned(node: ts.Node): boolean {
  if (ts.isReturnStatement(node)) return isRowValue(node.expression);
  return ts.isArrowFunction(node) && isRowValue(node.body);
}

function isObjectRest(node: ts.Node): boolean {
  return ts.isBindingElement(node) && node.dotDotDotToken !== undefined && ts.isObjectBindingPattern(node.parent);
}

/** What the node does with a whole row, or nothing when it names its fields. */
function leakAt(node: ts.Node): string | undefined {
  if (ts.isSpreadAssignment(node) && isRowValue(node.expression)) {
    return "row spread into a response";
  }
  if (isWholeRowSent(node)) return "row sent whole";
  if (isWholeRowReturned(node)) return "row returned whole";
  return isObjectRest(node) ? "object rest binding" : undefined;
}

function leaksIn(module: DoctorModule): readonly SignalEvidence[] {
  const found: SignalEvidence[] = [];
  visitNodes(module.source, (node) => {
    const leak = leakAt(node);
    if (leak !== undefined) found.push(evidenceAt(module, node, leak));
  });
  return found;
}

function countWholeRows(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const module of context.program().modules) {
    if (!isProductionModule(module.path)) continue;
    if (!isResponseCode(module)) continue;
    const found = leaksIn(module);
    readings.set(module.path, { value: found.length, evidence: found });
  }
  return readings;
}

export const rowsSentWholeSignal: DoctorSignal = {
  id: "rows-sent-whole",
  issue: "its-not-you-its-my-boundaries",
  question:
    "Does response code spread, return, or send a whole row, or bind an object rest, instead of naming each field it sends?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "If persistence can force the API to move",
  run: (context) => Promise.resolve(countWholeRows(context)),
};
