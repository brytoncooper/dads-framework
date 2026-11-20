/**
 * One request's environment, as `request_log` keeps it (90 days): how it
 * arrived, where from, and what it was told.
 */
export type RequestLogEntry = {
  readonly requestId: string;
  readonly recordedAt: Date;
  readonly method: string;
  /** The matched route template, never the raw path; null when none matched. */
  readonly routeId: string | null;
  readonly status: number;
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** The decoded `x-client-context` header, as stored. */
  readonly clientContext: Readonly<Record<string, unknown>> | null;
};

/**
 * Where the previous page of refusals stopped. `recordedAt` is the stored
 * instant to the microsecond as UTC text; `requestId` breaks ties within one
 * microsecond and is null when the caller could not carry it.
 */
export type RequestLogCursor = {
  readonly recordedAt: string;
  readonly requestId: string | null;
};

/** A signed-in actor's request that was refused: denied, not found, or unauthenticated. */
export type RefusedRequest = {
  readonly requestId: string;
  readonly recordedAt: Date;
  readonly actorKind: string;
  readonly actorId: string;
  /** The staff sign-in-as session the request was made under; null otherwise. */
  /** `denied`, `not-found` or `unauthenticated`. */
  readonly decision: string;
  readonly permission: string | null;
  readonly routeId: string | null;
  readonly method: string;
  /** This row's own keyset position, to resume a page after it. */
  readonly cursor: RequestLogCursor;
};

/** Narrowing for refusals; they combine with AND. */
export type RefusedRequestFilter = {
  /** Inclusive lower bound on `recorded_at`; the log keeps 90 days anyway. */
  readonly since: Date;
  /** The person behind the request, directly or for a company. */
  readonly userId?: string;
};

/**
 * No behavior lives in this file — it is not a wrapper or a pass-through.
 * This abstract class is the port for reading `request_log`: the type a
 * caller holds AND the injection token composition binds.
 * `DrizzleRequestLogReader` (database/readers/) implements it.
 */
export abstract class RequestLogReader {
  /** One request by its id; null once pruned or when it was never logged. */
  abstract findRequest(requestId: string): Promise<RequestLogEntry | null>;

  /**
   * Refused requests of a signed-in actor (never `anonymous`, never one with
   * no actor id), newest first by `(recorded_at, request_id)`, strictly
   * older than `olderThan` when given, at most `limit` of them.
   */
  abstract listRefusals(
    filter: RefusedRequestFilter,
    olderThan: RequestLogCursor | null,
    limit: number,
  ): Promise<readonly RefusedRequest[]>;
}
