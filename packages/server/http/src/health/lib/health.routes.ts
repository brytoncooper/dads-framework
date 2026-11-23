import { publicAccess } from "../../lib/route/access.js";
import { getRoute } from "../../lib/route/get-route.js";
import type { RouteBlueprint } from "../../lib/route/route-definition.js";
import { routeGroup, type HttpRoute } from "../../lib/route/route-group.js";
import { createHealthRouteHandlers, type HealthRouteHandlers, type ReadinessChecks } from "./health.route-handlers.js";
import { healthStatusSchema, readyStatusSchema } from "./health.schemas.js";

export type { ReadinessChecks } from "./health.route-handlers.js";

/** /health is liveness; /ready checks dependencies before serving traffic. */
export function createHealthRoutes(checks: ReadinessChecks): HttpRoute[] {
  const handlers = createHealthRouteHandlers(checks);
  return routeGroup("Health", healthRouteCards(handlers));
}

/** Reviewed infrastructure probes use local schemas and no client binding. */
function healthRouteCards(handlers: HealthRouteHandlers): RouteBlueprint[] {
  return [
    getRoute({
      path: "/health",
      summary: "Liveness — answers without touching dependencies",
      access: publicAccess(),
      response: healthStatusSchema,
      handler: handlers.getHealth,
    }),
    getRoute({
      path: "/ready",
      summary: "Readiness — critical services reachable",
      access: publicAccess(),
      response: readyStatusSchema,
      handler: handlers.getReady,
    }),
  ];
}
