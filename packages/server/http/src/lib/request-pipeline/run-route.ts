import type { FastifyRequest } from "fastify";

import type { RawRouteInput, RouteDefinition, RouteResult } from "../route/route-definition.js";
import type { AccessDecision } from "./enforce-access.js";
import type { FeatureStateSnapshot } from "./feature-state.js";
import { requestIdOf } from "./request-id.js";
import { requestLocaleOf } from "./request-locale.js";
import { withDeadline } from "./with-deadline.js";

/**
 * What enforcement settled beyond the subjects, for the route's input. A part
 * enforcement did not set stays absent rather than arriving as `undefined`.
 */
function forwardedDecision(
  decision: Extract<AccessDecision, { outcome: "allow" }>,
): Partial<
  Pick<
    RawRouteInput,
    "untrustedAuthorizationContext" | "authorizationContext" | "sessionReauthenticatedAt" | "visibleIds" | "scope"
  >
> {
  return {
    ...(decision.untrustedAuthorizationContext === undefined
      ? {}
      : {
          untrustedAuthorizationContext: decision.untrustedAuthorizationContext,
        }),
    ...(decision.authorizationContext === undefined ? {} : { authorizationContext: decision.authorizationContext }),
    ...(decision.sessionReauthenticatedAt === undefined
      ? {}
      : { sessionReauthenticatedAt: decision.sessionReauthenticatedAt }),
    ...(decision.visibleIds === undefined ? {} : { visibleIds: decision.visibleIds }),
    ...(decision.scope === undefined ? {} : { scope: decision.scope }),
  };
}

/** Runs the route's typed pipeline (parse → handler → parse) under the deadline. */
export function runRoute(
  definition: RouteDefinition,
  request: FastifyRequest,
  decision: Extract<AccessDecision, { outcome: "allow" }>,
  timeoutMs: number,
  featureState?: FeatureStateSnapshot,
): Promise<RouteResult> {
  return withDeadline(
    definition.execute({
      params: request.params,
      query: request.query,
      body: request.body,
      subject: decision.subject,
      authenticatedSubject: decision.authenticatedSubject,
      requestId: requestIdOf(request),
      locale: requestLocaleOf(request),
      log: request.log,
      ...forwardedDecision(decision),
      ...(featureState === undefined ? {} : { featureState }),
    }),
    timeoutMs,
    definition.path,
    request.log,
  );
}
