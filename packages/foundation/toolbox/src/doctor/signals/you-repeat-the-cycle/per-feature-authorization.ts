/**
 * An `authorize`-shaped function outside the authorization package: ceiling 0.
 *
 * Access is one question asked of one model. A function called `canEditOrder`
 * in the orders package is a second model — smaller, undocumented, and true
 * only of orders — and the day the two disagree nobody will know which one the
 * request went through. The name is the tell: a package that had asked the
 * authorization model would not need a verb of its own.
 *
 * Each prefix is matched only where a capitalised word follows it, so `cancel`
 * and `canonicalName` are left alone, and so is `authorizedChange` — a noun
 * for something that was authorized elsewhere is not a function that decides.
 * The authorization package itself is exempt, because that is the one place
 * these functions belong.
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
  isProductionModule,
  ts,
  visitNodes,
  type DoctorModule,
} from "../scanners/typescript-program.js";

const DECIDES_ACCESS = /^(?:authorize|isAllowed|can)(?:[A-Z0-9]|$)/;
const AUTHORIZATION_PACKAGE = /(?:authorization|(?:^|\/|-)access)(?:$|\/)/;

function isFunctionValue(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/** The name a node declares, when the node declares a function. */
function declaredFunctionName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name !== undefined && ts.isIdentifier(node.name)
      ? node.name.text
      : undefined;
  }
  if (!ts.isVariableDeclaration(node)) return undefined;
  if (node.initializer === undefined || !isFunctionValue(node.initializer)) {
    return undefined;
  }
  return ts.isIdentifier(node.name) ? node.name.text : undefined;
}

function accessDeciders(module: DoctorModule): readonly SignalEvidence[] {
  const found: SignalEvidence[] = [];
  visitNodes(module.source, (node) => {
    const name = declaredFunctionName(node);
    if (name === undefined || !DECIDES_ACCESS.test(name)) return;
    found.push(evidenceAt(module, node, name));
  });
  return found;
}

function countFeatureAuthorization(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const module of context.program().modules) {
    if (!isProductionModule(module.path)) continue;
    if (AUTHORIZATION_PACKAGE.test(module.packageRoot)) continue;
    const evidence = accessDeciders(module);
    readings.set(module.path, { value: evidence.length, evidence });
  }
  return readings;
}

export const perFeatureAuthorizationSignal: DoctorSignal = {
  id: "per-feature-authorization",
  issue: "you-repeat-the-cycle",
  question:
    "Is a function named `authorize*`, `can*`, or `isAllowed*` defined outside the authorization package?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "Every feature invents its own auth. Like your father before you.",
  run: (context) => Promise.resolve(countFeatureAuthorization(context)),
};
