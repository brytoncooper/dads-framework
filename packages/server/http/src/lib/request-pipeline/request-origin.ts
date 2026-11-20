import type { FastifyRequest } from "fastify";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The origin the current request reached this server on
 * (`https://site.example`, never a path), kept for the request's own async
 * task. Code far from the route (a storage driver signing a link a browser
 * will open) reads it to name the server the way the browser did.
 */
const requestOriginContext = new AsyncLocalStorage<{
  readonly origin: string;
}>();

/**
 * Records the request's origin for everything it goes on to do. `enterWith`
 * for the reason `enterAuditActor` gives: an `onRequest` hook has to return,
 * so it cannot wrap the handler in a callback.
 *
 * Scheme and host come from Fastify, which reads `X-Forwarded-Proto` and
 * `X-Forwarded-Host` only from as many proxy hops as `trustedProxyHops` names.
 * A host that does not form an origin records nothing.
 */
export function enterRequestOrigin(request: FastifyRequest): void {
  const origin = originOf(request);
  if (origin !== undefined) requestOriginContext.enterWith({ origin });
}

/**
 * The origin the current request reached this server on, or `fallback`
 * outside any request (a job, a startup hook, a script).
 */
export function requestOriginOr(fallback: string): string {
  return requestOriginContext.getStore()?.origin ?? fallback;
}

function originOf(request: FastifyRequest): string | undefined {
  try {
    return new URL(`${request.protocol}://${request.host}`).origin;
  } catch {
    return undefined;
  }
}
