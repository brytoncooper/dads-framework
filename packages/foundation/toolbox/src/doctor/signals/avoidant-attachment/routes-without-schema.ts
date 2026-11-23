/**
 * A route blueprint missing an input or an output schema: ceiling 0.
 *
 * The schemas are the contract. Without them a consumer has the path and a
 * hope, and the first question they ask gets answered in a thread rather than
 * in a type. So each operation is asked for the schemas its own shape needs and
 * for nothing else:
 *
 * - a path with parameters in it needs `params`, because the parameters are
 *   already part of the contract whether or not anybody parsed them;
 * - a `POST`, `PATCH` or `PUT` needs `body`, because it takes one;
 * - everything but a `DELETE` needs an output — `response` for one resource,
 *   `item` for a page of them. A `DELETE` returns no content, and demanding a
 *   schema for nothing is how a rule loses the argument.
 *
 * The number is how many of the schemas its shape requires are missing, so an
 * operation with neither an input nor an output reads two rather than one.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReading } from "../../doctor-signal.js";
import { operationEvidence, operationKey, readRouteModel, type RouteOperation } from "../scanners/route-model.js";

const BODY_METHODS = new Set(["POST", "PATCH", "PUT"]);

function missingSchemas(operation: RouteOperation): readonly string[] {
  if (operation.raw === true) return [];
  const schemas = operation.schemas;
  const missing: string[] = [];
  if (operation.routePath.includes(":") && schemas.params === undefined) {
    missing.push("params");
  }
  if (BODY_METHODS.has(operation.method) && schemas.body === undefined) {
    missing.push("body");
  }
  const output = schemas.response ?? schemas.item;
  if (operation.method !== "DELETE" && output === undefined) {
    missing.push("response");
  }
  return missing;
}

function countMissingSchemas(context: DoctorContext) {
  const readings = new Map<string, SignalReading>();
  for (const operation of readRouteModel(context).operations) {
    const missing = missingSchemas(operation);
    const where = operationEvidence(operation);
    readings.set(operationKey(operation), {
      value: missing.length,
      evidence: missing.map((schema) => ({
        path: where.path,
        line: where.line,
        name: `${where.name}: ${schema}`,
      })),
    });
  }
  return readings;
}

export const routesWithoutSchemaSignal: DoctorSignal = {
  id: "routes-without-schema",
  issue: "avoidant-attachment",
  question: "Does any route blueprint lack an input or an output schema?",
  reads: "routes",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "No schemas. No access declarations. No envelope.",
  run: (context) => Promise.resolve(countMissingSchemas(context)),
};
