/**
 * Request shapes that accept what they never advertised: ceiling 0.
 *
 * `z.object` strips. A client that sends `{ nmae: "Acme" }` gets a 201 and a
 * record with no name, because the misspelled key was quietly dropped and the
 * required one was optional all along. `z.looseObject` is the opposite and
 * worse on the way in: it keeps whatever arrived. `z.strictObject` refuses
 * the key nobody declared, which is the only answer that tells the caller.
 *
 * Responses are a different question and are left alone: on the way out,
 * stripping is what stops an internal column reaching a client, and a strict
 * response would turn a wide row into a 500. So an object in a response
 * position does not count: inside a declaration named `…Response` or
 * `…ResponseSchema`, inside a call whose name says response, or as the value
 * of a `response` or `output` property.
 *
 * Either escape is allowed when the comment block above it names its authority
 * — `// foreign-spec:` for an external specification that says to ignore what
 * we do not advertise, `// response-shape:` for a shape travelling out. The
 * comment is the point: it turns "somebody used `z.object`" into "somebody
 * named why".
 *
 * Read where a request shape is decided: a module that declares routes, and
 * every module of a contract package — one whose manifest name is `contract`,
 * or ends in `-contract` or `-contracts`, which is where an application
 * publishes the shapes its clients send. Every such module holding an object
 * schema is a key, zeros included.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalEvidence, SignalReading, SignalReadings } from "../../doctor-signal.js";
import { manifestRootOf, readPackageGraph } from "../scanners/package-graph.js";
import { declaresRoutes } from "../scanners/response-code.js";
import {
  evidenceAt,
  isProductionModule,
  lineOf,
  ts,
  visitNodes,
  type DoctorModule,
} from "../scanners/typescript-program.js";

const OBJECT_BUILDERS = new Set(["object", "looseObject", "strictObject"]);
const STRICT = "strictObject";
const LOOSE = "looseObject";
const ZOD = "z";
const NAMED_ESCAPE = /^(?:\/\/|\/?\*+)\s*(?:foreign-spec|response-shape):/;
const COMMENT_LINE = /^(?:\/\/|\/\*|\*)/;
const RESPONSE_NAME = /Response(?:Schema)?$/;
const RESPONSE_CALL = /response/i;
const RESPONSE_PROPERTIES = new Set(["response", "output"]);
const CONTRACT_PACKAGE = /(?:^|[/-])contracts?$/;

/** The builder a `z.<builder>(…)` call names, or nothing. */
function objectBuilder(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  if (!ts.isIdentifier(callee.expression)) return undefined;
  if (callee.expression.text !== ZOD) return undefined;
  return OBJECT_BUILDERS.has(callee.name.text) ? callee.name.text : undefined;
}

function positionNameOf(node: ts.Node): string | undefined {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
    return node.name.text;
  }
  if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    return node.expression.text;
  }
  return undefined;
}

function marksResponse(node: ts.Node): boolean {
  const name = positionNameOf(node);
  if (name === undefined) return false;
  if (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) {
    return RESPONSE_NAME.test(name);
  }
  if (ts.isPropertyAssignment(node)) return RESPONSE_PROPERTIES.has(name);
  return RESPONSE_CALL.test(name);
}

/** True when the object is on its way out rather than in. */
function isResponsePosition(node: ts.Node): boolean {
  for (let current = node.parent; !ts.isSourceFile(current);) {
    if (marksResponse(current)) return true;
    current = current.parent;
  }
  return false;
}

/** The comment lines directly above a line, nearest first, blanks skipped. */
function commentLinesAbove(lines: readonly string[], line: number): string[] {
  const found: string[] = [];
  for (let index = line - 2; index >= 0; index -= 1) {
    const text = (lines[index] ?? "").trim();
    if (text.length === 0 && found.length === 0) continue;
    if (!COMMENT_LINE.test(text)) break;
    found.push(text);
  }
  return found;
}

/** True when the comment block above the call names its authority. */
function isEscaped(module: DoctorModule, node: ts.Node): boolean {
  const lines = module.source.text.split("\n");
  return commentLinesAbove(lines, lineOf(module, node)).some((text) => NAMED_ESCAPE.test(text));
}

/** The package roots whose manifest names a contract package. */
function contractRoots(context: DoctorContext): ReadonlySet<string> {
  return new Set(
    readPackageGraph(context)
      .manifests.filter((manifest) => CONTRACT_PACKAGE.test(manifest.name ?? ""))
      .map((manifest) => manifestRootOf(manifest)),
  );
}

type ObjectSchemas = {
  readonly seen: number;
  readonly loose: readonly SignalEvidence[];
};

function isLooseRequest(module: DoctorModule, node: ts.Node): boolean {
  const builder = objectBuilder(node);
  if (builder === undefined || builder === STRICT) return false;
  if (isEscaped(module, node)) return false;
  return builder === LOOSE || !isResponsePosition(node);
}

function readObjectSchemas(module: DoctorModule): ObjectSchemas {
  let seen = 0;
  const loose: SignalEvidence[] = [];
  visitNodes(module.source, (node) => {
    if (objectBuilder(node) === undefined) return;
    seen += 1;
    if (!isLooseRequest(module, node)) return;
    loose.push(evidenceAt(module, node, `z.${objectBuilder(node) ?? ""}`));
  });
  return { seen, loose };
}

function countLooseObjects(context: DoctorContext): SignalReadings {
  const contracts = contractRoots(context);
  const readings = new Map<string, SignalReading>();
  for (const module of context.program().modules) {
    if (!isProductionModule(module.path)) continue;
    if (!module.source.text.includes("bject(")) continue;
    if (!contracts.has(module.packageRoot) && !declaresRoutes(module)) continue;
    const found = readObjectSchemas(module);
    if (found.seen === 0) continue;
    readings.set(module.path, {
      value: found.loose.length,
      evidence: found.loose,
    });
  }
  return readings;
}

export const looseContractObjectsSignal: DoctorSignal = {
  id: "loose-contract-objects",
  issue: "people-pleasing",
  question:
    "Does a published request shape use `z.object` or `z.looseObject` without a comment naming the authority that allows it?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "Nobody loves you more. They just know you’ll fold.",
  run: (context) => Promise.resolve(countLooseObjects(context)),
};
