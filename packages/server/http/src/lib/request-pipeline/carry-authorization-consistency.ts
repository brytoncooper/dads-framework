import type { FastifyReply, FastifyRequest } from "fastify";

import {
  authorizationConsistencySetCookie,
  authorizationConsistencyTokenFromCookieHeader,
  runWithAuthorizationConsistency,
  writtenAuthorizationConsistencyOnThisRequest,
} from "@dads-framework/access/runtime";

export function carryAuthorizationConsistency<T>(
  request: FastifyRequest,
  work: () => T,
): T {
  return runWithAuthorizationConsistency(
    authorizationConsistencyTokenFromCookieHeader(request.headers.cookie),
    work,
  );
}

export function attachWrittenAuthorizationConsistencyCookie(
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const written = writtenAuthorizationConsistencyOnThisRequest();
  if (written === undefined) return;
  void reply.header(
    "set-cookie",
    authorizationConsistencySetCookie(written, {
      secure: requestIsHttps(request),
    }),
  );
}

function requestIsHttps(request: FastifyRequest): boolean {
  const forwarded = request.headers["x-forwarded-proto"];
  if (forwarded === "https") return true;
  if (Array.isArray(forwarded) && forwarded[0] === "https") return true;
  return request.protocol === "https";
}
