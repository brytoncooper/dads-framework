import { requestIdSchema } from "@dads-framework/http";
import { deterministicUuid } from "@dads-framework/postgres/testing/deterministic-uuid";
import type { requestLog } from "../lib/database/generated-tables/request-log.tables.js";

type RequestLogInsert = typeof requestLog.$inferInsert;

let requestLogCounter = 0;

/**
 * Every field valid by default, deterministic ids, overrides spread last
 * (docs/testing/seeders.md).
 *
 * Unlike `audit_log`, application code is the only writer of `request_log` —
 * no trigger fills it in — so this factory builds the row a caller would
 * actually insert, not a row the database minted.
 */
export function makeRequestLog(overrides: Partial<RequestLogInsert> = {}): RequestLogInsert {
  requestLogCounter += 1;
  return {
    requestId: requestIdSchema.parse(deterministicUuid("request", requestLogCounter)),
    method: "POST",
    routeId: "/organizations/:organizationId/orders",
    path: "/organizations/:organizationId/orders",
    status: 201,
    durationMs: 42,
    actorKind: "user",
    actorId: "test",
    authMethod: "session-cookie",
    accessKind: "permission",
    permission: "orders.create",
    resourceType: "organizations/order",
    resourceId: null,
    decision: "allow",
    errorCode: null,
    ip: null,
    forwardedFor: null,
    userAgent: null,
    clientHints: null,
    acceptLanguage: null,
    clientContext: null,
    apiRelease: null,
    ...overrides,
  };
}
