/**
 * A branch on a role outside the authorization model: report, then ceiling 0.
 *
 * A role compared to a string is a permission decision that no model can see,
 * no test can enumerate, and no reviewer can diff against a policy. It also
 * ages badly in one direction only: the ladder grows a rung per feature and
 * loses one never.
 *
 * The reading is an `if` or a `switch` that compares a role-named expression
 * against the name of a permission — admin, owner, member, viewer, and the
 * rest of the vocabulary a policy is written in. Both halves are needed. A
 * field called `role` compared against `"postgres_data"` or `"source"` is a
 * kind, not a permission, and every codebase has several of those; a
 * permission name compared against something that is not a role is somebody
 * naming a relationship.
 *
 * A module that reaches an access or authorization model is not measured. Such
 * a module is translating a role into relationships, which is the direction
 * this issue asks for; the failure is a module that decides on a role and
 * never asks anybody.
 *
 * It is a taint-lite reading — a name, not a proof — so it is report-only
 * under `standard` and earns its ceiling in `strict` only where the corpus
 * shows it quiet.
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
  moduleImports,
  ts,
  visitNodes,
  type DoctorModule,
} from "../scanners/typescript-program.js";

const ROLE_NAME = /(?:^|[a-z])roles?$/i;
const ASKS_A_MODEL = /author|access/i;
const AUTHORIZATION = "authorization";

/** The vocabulary a permission is named in, which a kind is not. */
const PERMISSIONS = new Set([
  "admin",
  "administrator",
  "superuser",
  "root",
  "owner",
  "member",
  "viewer",
  "editor",
  "moderator",
  "guest",
  "staff",
  "manager",
]);
const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** True for `role`, `userRole`, `member.role`, and their plurals. */
function namesARole(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return ROLE_NAME.test(node.text);
  if (ts.isPropertyAccessExpression(node)) {
    return ROLE_NAME.test(node.name.text);
  }
  return false;
}

function namesAPermission(node: ts.Node): boolean {
  return ts.isStringLiteral(node) && PERMISSIONS.has(node.text.toLowerCase());
}

function comparesARole(node: ts.Node): boolean {
  if (!ts.isBinaryExpression(node)) return false;
  if (!COMPARISONS.has(node.operatorToken.kind)) return false;
  const named = namesARole(node.left) || namesARole(node.right);
  const permission =
    namesAPermission(node.left) || namesAPermission(node.right);
  return named && permission;
}

/** True when the module reaches an access or authorization model at all. */
function asksAModel(module: DoctorModule): boolean {
  return moduleImports(module).some((imported) =>
    ASKS_A_MODEL.test(imported.specifier),
  );
}

function switchesOnAPermission(node: ts.SwitchStatement): boolean {
  if (!namesARole(node.expression)) return false;
  return node.caseBlock.clauses.some(
    (clause) => ts.isCaseClause(clause) && namesAPermission(clause.expression),
  );
}

/** What a node is branching on, when it is branching on a role. */
function roleBranch(node: ts.Node): string | undefined {
  if (ts.isSwitchStatement(node)) {
    return switchesOnAPermission(node) ? "switch on a role" : undefined;
  }
  if (!ts.isIfStatement(node)) return undefined;
  let found = false;
  visitNodes(node.expression, (child) => {
    if (comparesARole(child)) found = true;
  });
  const compared = comparesARole(node.expression) || found;
  return compared ? "if on a role" : undefined;
}

function collectRoleBranches(
  module: DoctorModule,
  readings: Map<string, SignalReading>,
): void {
  visitNodes(module.source, (node) => {
    const branch = roleBranch(node);
    if (branch === undefined) return;
    addFinding(readings, module.packageRoot, evidenceAt(module, node, branch));
  });
}

function countRoleLadders(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const module of context.program().modules) {
    if (!isProductionModule(module.path)) continue;
    if (module.packageRoot.includes(AUTHORIZATION)) continue;
    if (asksAModel(module)) continue;
    collectRoleBranches(module, readings);
  }
  return readings;
}

export const roleIfLaddersSignal: DoctorSignal = {
  id: "role-if-ladders",
  issue: "you-repeat-the-cycle",
  question:
    "Does an `if` or `switch` branch on a role outside the authorization model?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: 0 },
  sentence:
    "Then you eat your denial test. There are children in other companies shipping role `if`s.",
  run: (context) => Promise.resolve(countRoleLadders(context)),
};
