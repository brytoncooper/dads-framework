import type { FastifyReply, FastifyRequest } from "fastify";

import { rememberErrorCode } from "../request-log/request-outcome.js";
import { resolveCapabilities, type RouteCapabilities } from "../route/capabilities.js";
import type { HttpRoute } from "../route/route-group.js";
import { createRateLimiter, type RateLimiter } from "./rate-limit.js";

/**
 * Wires the rate-limit engine into the request pipeline: which limiter a
 * route gets, how its budget is spent, and the 429 a spent caller sees.
 */

/** The per-route limiter, or null when the effective policy is unlimited. */
export function limiterFor(definition: HttpRoute, appCapabilities: RouteCapabilities | undefined): RateLimiter | null {
  const effective = resolveCapabilities(appCapabilities, undefined, definition.capabilities);
  const limit = effective.rateLimit;
  if (limit === undefined || limit === "unlimited") return null;
  return createRateLimiter(limit, Date.now);
}

export function sendRateLimited(request: FastifyRequest, reply: FastifyReply, retryAfterSeconds: number): FastifyReply {
  void reply.header("retry-after", String(retryAfterSeconds));
  rememberErrorCode(request, "TOO_MANY_REQUESTS");
  return reply.status(429).send({
    error: {
      code: "TOO_MANY_REQUESTS",
      message: "Rate limit exceeded — retry after the indicated delay",
    },
  });
}

/** Budget is consumed AFTER access — a denied caller learns nothing. */
export function consumeBudget(
  limiter: RateLimiter | null,
  definition: HttpRoute,
  request: FastifyRequest,
  subjectId: string | undefined,
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  if (!limiter) return { allowed: true };
  return limiter.consume(`${definition.method} ${definition.path}`, subjectId ?? request.ip);
}
