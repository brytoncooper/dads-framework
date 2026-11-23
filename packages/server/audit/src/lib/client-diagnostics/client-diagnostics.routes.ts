/**
 * The one route a client reports a fault through.
 *
 * **Public on purpose.** The failures worth hearing about most are the ones
 * that happen before or instead of a session: a login page that threw, a
 * bundle that would not load, a router that could not reach the first screen.
 * A route requiring a session would be deaf to exactly those.
 *
 * What makes a public write acceptable here is that it is bounded in every
 * direction rather than trusted in any: the contract caps the batch and every
 * field inside it, the body limit caps the request, the identity on the row
 * is the server's own and never the report's, and the answer is a count
 * rather than anything a caller could treat as a resource it owns.
 */

import { postRoute, publicAccess, routeGroup, type HttpRoute } from "@dads-framework/http";
import { reportClientDiagnosticsBodySchema, reportedClientDiagnosticsSchema } from "@dads-framework/core/contract";

import type { ClientDiagnosticsRouteHandlers } from "./client-diagnostics.route-handlers.js";

export function createClientDiagnosticsRoutes(handlers: ClientDiagnosticsRouteHandlers): HttpRoute[] {
  // Bound here rather than in the handler module: handler modules hold
  // methods in the route declaration, and a method handed to the
  // router as a value would arrive without its `this`.
  const reportClientDiagnostics = handlers.reportClientDiagnostics.bind(handlers);
  return routeGroup("Client diagnostics", [
    postRoute({
      path: "/client-diagnostics",
      summary: "Report faults a client hit that never became a request",
      access: publicAccess(),
      resourcePolicy: {
        kind: "resource-free",
        purpose: "append-only-telemetry",
      },
      body: reportClientDiagnosticsBodySchema,
      response: reportedClientDiagnosticsSchema,
      // 200, not 202: the batch is stored before the answer, and the answer
      // says how many rows landed. `postRoute` admits 200 or 201, and 201
      // would claim a resource the client has no way to address.
      status: 200,
      handler: reportClientDiagnostics,
    }),
  ]);
}
