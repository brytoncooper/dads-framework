/**
 * A tenant column used as the access check: report, then ceiling 0.
 *
 * `WHERE organization_id = $1` is not authorization. It is a filter that
 * happens to exclude most of the rows an attacker wanted, and it answers a
 * different question from the one the request asked: not "may this subject see
 * this object" but "is this row in the same company as some other row". It
 * cannot express a share, a delegation, or a revocation, and there is no place
 * to look up what it decided.
 *
 * Two spellings are read. The first is SQL: a `where` clause naming a tenant
 * column with a comparison after it, in a string literal of a module or in a
 * `.sql` file. The second is the query-builder form, a tenant-named property
 * inside a `where`, `and`, or `eq` call. Only string literals are read, never
 * comments — which is why the question this signal asks, and the column names
 * it has to list to ask it, do not read as occurrences of themselves.
 *
 * It is a taint-lite reading, so it is report-only under `standard` and earns
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
  containsNode,
  evidenceAt,
  ts,
  visitNodes,
  type DoctorModule,
} from "../scanners/typescript-program.js";

const TENANT_FILTER =
  /\bwhere\b[\s\S]{0,200}?\b(?:organization_id|tenant_id|account_id|workspace_id)\b\s*(?:=|in\b)/i;
const TENANT_PROPERTY = /^(?:organizationId|tenantId|accountId|workspaceId)$/;
const FILTER_CALLS = new Set(["where", "andWhere", "and", "eq"]);
const SQL_SUFFIX = ".sql";
const FOUND = "tenant column as the access check";

function isTenantProperty(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    return TENANT_PROPERTY.test(node.name.text);
  }
  return ts.isIdentifier(node) && TENANT_PROPERTY.test(node.text);
}

function calledName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : "";
}

/** True for `where(...)`, `and(...)`, `eq(...)` closing over a tenant column. */
function isTenantFilterCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  if (!FILTER_CALLS.has(calledName(node.expression))) return false;
  return node.arguments.some((argument) =>
    containsNode(argument, isTenantProperty),
  );
}

function isTenantSql(node: ts.Node): boolean {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return TENANT_FILTER.test(node.text);
  }
  if (!ts.isTemplateExpression(node)) return false;
  const spans = node.templateSpans.map((span) => span.literal.text);
  return TENANT_FILTER.test([node.head.text, ...spans].join(" ? "));
}

function collectTenantFilters(
  module: DoctorModule,
  readings: Map<string, SignalReading>,
): void {
  visitNodes(module.source, (node) => {
    if (!isTenantSql(node) && !isTenantFilterCall(node)) return;
    addFinding(readings, module.packageRoot, evidenceAt(module, node, FOUND));
  });
}

function collectSqlFiles(
  context: DoctorContext,
  readings: Map<string, SignalReading>,
): void {
  for (const path of context.files()) {
    if (!path.endsWith(SQL_SUFFIX)) continue;
    if (!TENANT_FILTER.test(context.read(path))) continue;
    addFinding(readings, path, { path, name: FOUND });
  }
}

function countTenantAuthorization(context: DoctorContext): SignalReadings {
  const readings = new Map<string, SignalReading>();
  for (const module of context.program().modules) {
    collectTenantFilters(module, readings);
  }
  collectSqlFiles(context, readings);
  return readings;
}

export const tenantColumnAuthorizationSignal: DoctorSignal = {
  id: "tenant-column-authorization",
  issue: "you-repeat-the-cycle",
  question:
    "For every table or column named like a tenant, is it used as the access check in a `WHERE` clause rather than a relationship lookup?",
  reads: "typescript",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: 0 },
  sentence:
    "You are not in trouble. Dad just wants you to explain why `organization_id` is in the authorization query while he stands silently in the doorway.",
  run: (context) => Promise.resolve(countTenantAuthorization(context)),
};
