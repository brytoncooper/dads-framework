/**
 * Every API call, announced to whoever is listening.
 *
 * Telemetry's problem is correlation: a browser fault is only half a story
 * until you can reach the request it was about, and through that request's id
 * the `request_log` row and the `audit_log` rows it produced. The transport
 * mints that id, so the transport is the only place that can say it.
 *
 * A LIST of listeners, not a slot. `registerRequestMetadata` next door is
 * deliberately singular — one owner may add headers and steer requests — and
 * the feature-flag runtime holds it. Observation is a different kind of thing:
 * several things may legitimately watch, and none of them may evict another.
 * Modelled on `unauthorized-response-channel.ts` beside it for exactly that
 * reason.
 *
 * Announcing is best-effort: a listener that throws is isolated, because a
 * broken observer must not break the request it was observing.
 */

import type { HttpMethod } from "./send-api-request.js";

/** One completed API call, as an observer needs to see it. */
export type ApiExchange = {
  readonly method: HttpMethod;
  /** The request path, without its query string. */
  readonly path: string;
  /** The status the API answered, or null when no response arrived. */
  readonly status: number | null;
  /** The id this call carried, which is `request_log`'s primary key. */
  readonly requestId: string;
  readonly durationMs: number;
  /**
   * True when the API refused the call for access: a 403, or a 404 its
   * access edge marked (`ACCESS_REFUSAL_HEADER`) rather than a record that
   * is not there. A 401 is a signed-out session, not this.
   */
  readonly refusedForAccess: boolean;
};

export type ApiExchangeListener = (exchange: ApiExchange) => void;

const listeners = new Set<ApiExchangeListener>();

/** Watch every API call. Returns the function that stops watching. */
export function onApiExchange(listener: ApiExchangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Tell every listener about one call.
 *
 * Not exported from the barrel: announcing is the transport's own business,
 * and a caller that could announce could forge correlation.
 */
export function announceApiExchange(exchange: ApiExchange): void {
  for (const listener of listeners) {
    try {
      listener(exchange);
    } catch {
      // A broken observer must not break the request it was observing.
    }
  }
}
