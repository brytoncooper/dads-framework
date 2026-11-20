/**
 * One `request_log` row, and the pure function that builds it.
 *
 * Nothing here touches Fastify. The capture hook hands over a plain object —
 * method, status, elapsed time, the headers, the actor in force, what access
 * settled — and gets back the row. That keeps the redaction rules testable
 * without a server: the allowlist below is the ONLY place a request header is
 * read, so "no cookie, no authorization, no query string, no body" is a
 * property of nine lines rather than a promise
 * (docs/architecture/observability.md).
 */

import type { AuditActor } from "@dads-framework/audit-actor";
import type { RequestWorkTally } from "@dads-framework/runtime/request-work";
import {
  CLIENT_CONTEXT_HEADER,
  decodeClientContext,
  type ClientContext,
} from "@dads-framework/contract";

/**
 * How the request ended, in the vocabulary `request_log.decision` stores.
 *
 * `denied` is access saying no (the wire still shows 404, so the table is the
 * only place the difference survives); `not-found` is nothing there to say no
 * about; `error` is every other unhappy status, the server's own 5xx included.
 */
export type RequestDecision =
  "allow" | "denied" | "not-found" | "unauthenticated" | "error";

/** What access settled, as the capture hook stashed it during the request. */
export type RequestAccessFacts = {
  readonly outcome: "allow" | "unauthenticated" | "not-found";
  /** Which access declaration answered — `public`, `session`, `permission`, `visibility`. */
  readonly accessKind: string;
  readonly permission?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly authMethod?: string;
};

/** Fastify's header bag, narrowed to what a pure function can be handed. */
export type RequestRecordHeaders = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

export type RequestRecordInput = {
  readonly requestId: string;
  readonly recordedAt: Date;
  readonly method: string;
  /** The raw url — read ONLY to fall back when no route matched. */
  readonly url: string;
  /** The matched route's pattern (`request.routeOptions.url`), when one matched. */
  readonly routePattern: string | undefined;
  readonly status: number;
  readonly durationMs: number;
  readonly headers: RequestRecordHeaders;
  /** `request.ip`, already resolved against the trusted proxy hop count. */
  readonly ip: string | undefined;
  readonly actor: AuditActor | undefined;
  readonly access: RequestAccessFacts | undefined;
  /** The `code` the error envelope reported, when the response was one. */
  readonly errorCode: string | undefined;
  readonly apiRelease: string | undefined;
  /**
   * What the request cost, as the counters saw it. `undefined` when nothing
   * started a tally — the row then keeps nulls, which reads as "not measured"
   * rather than as "did no work".
   */
  readonly work: RequestWorkTally | undefined;
  /** Which process answered — the container hostname. */
  readonly instanceId: string | undefined;
  /** The trace this request belonged to, when one was running. */
  readonly traceId: string | undefined;
  /**
   * What failed, when something did. Type and fingerprint only — the message
   * and stack stay in the log line keyed by this request id, because a message
   * can quote whatever a user typed and this table is bounded by retention.
   */
  readonly exception:
    { readonly type: string; readonly fingerprint: string } | undefined;
};

/**
 * The row itself. Field names are the table's column names in camel case, so
 * a sink inserts it without a translation layer between here and the schema.
 */
export type RequestRecord = {
  readonly requestId: string;
  readonly recordedAt: Date;
  readonly method: string;
  readonly routeId: string | null;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  readonly actorKind: string;
  readonly actorId: string;
  readonly authMethod: string | null;
  readonly accessKind: string | null;
  readonly permission: string | null;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly decision: RequestDecision;
  readonly errorCode: string | null;
  readonly ip: string | null;
  readonly forwardedFor: string | null;
  readonly userAgent: string | null;
  readonly clientHints: Record<string, string> | null;
  readonly acceptLanguage: string | null;
  readonly clientContext: ClientContext | null;
  readonly apiRelease: string | null;
  readonly dbQueryCount: number | null;
  readonly dbMs: number | null;
  readonly authzCheckCount: number | null;
  readonly authzMs: number | null;
  readonly authzCachedReadCount: number | null;
  readonly authzFullyConsistentReadCount: number | null;
  readonly authzLargestLookupCount: number | null;
  readonly instanceId: string | null;
  readonly traceId: string | null;
  readonly exceptionType: string | null;
  readonly exceptionFingerprint: string | null;
};

const USER_AGENT_HEADER = "user-agent";
const ACCEPT_LANGUAGE_HEADER = "accept-language";
const FORWARDED_FOR_HEADER = "x-forwarded-for";
/** Client hints are a family, not a header: `sec-ch-ua`, `-platform`, `-mobile`, … */
const CLIENT_HINT_PREFIX = "sec-ch-ua";

/** One absurd user agent must not decide how wide a row gets. */
const MAX_HEADER_VALUE_LENGTH = 512;
/** A client that invents client hints cannot turn one row into a document. */
const MAX_CLIENT_HINTS = 16;

/**
 * What the request cost, or nulls when nothing measured it.
 *
 * All seven move together on purpose: a row with a query count but no duration
 * would invite the reader to assume the missing half is zero. Either the
 * counters ran for this request or they did not.
 */
function whatItCost(work: RequestWorkTally | undefined): {
  dbQueryCount: number | null;
  dbMs: number | null;
  authzCheckCount: number | null;
  authzMs: number | null;
  authzCachedReadCount: number | null;
  authzFullyConsistentReadCount: number | null;
  authzLargestLookupCount: number | null;
} {
  if (work === undefined) {
    return {
      dbQueryCount: null,
      dbMs: null,
      authzCheckCount: null,
      authzMs: null,
      authzCachedReadCount: null,
      authzFullyConsistentReadCount: null,
      authzLargestLookupCount: null,
    };
  }
  return {
    dbQueryCount: work.dbQueryCount,
    dbMs: Math.round(work.dbMs),
    authzCheckCount: work.authzCheckCount,
    authzMs: Math.round(work.authzMs),
    authzCachedReadCount: work.authzCachedReadCount,
    authzFullyConsistentReadCount: work.authzFullyConsistentReadCount,
    authzLargestLookupCount: work.authzLargestLookupCount,
  };
}

/**
 * A path segment safe to keep verbatim when no route pattern is available:
 * letters and hyphens only, so `orders` and `sign-up` survive while anything
 * carrying a digit — every id shape this system mints — does not.
 */
const NON_IDENTIFYING_SEGMENT = /^[A-Za-z][A-Za-z-]*$/;

export function buildRequestRecord(input: RequestRecordInput): RequestRecord {
  return {
    requestId: input.requestId,
    recordedAt: input.recordedAt,
    method: input.method,
    routeId: input.routePattern ?? null,
    path: input.routePattern ?? maskUnmatchedPath(input.url),
    status: input.status,
    durationMs: input.durationMs,
    decision: resolveDecision(input.status, input.access),
    errorCode: input.errorCode ?? null,
    ...whoServedIt(input),
    ...whatFailed(input.exception),
    ...whatItCost(input.work),
    ...whoAsked(input.actor),
    ...whatAccessSettled(input.access),
    ...whereItCameFrom(input),
  };
}

/**
 * Which build, which process, which trace.
 *
 * Grouped because they answer one question — "where was this served" — and
 * because they are the three fields most likely to be null together: a
 * deployment that stamps no release tends also to run no tracing.
 */
function whoServedIt(input: RequestRecordInput): {
  apiRelease: string | null;
  instanceId: string | null;
  traceId: string | null;
} {
  return {
    apiRelease: input.apiRelease ?? null,
    instanceId: input.instanceId ?? null,
    traceId: input.traceId ?? null,
  };
}

/**
 * What failed, or nulls.
 *
 * Both move together: a type without a fingerprint could not be grouped, and
 * a fingerprint without a type could not be read.
 */
function whatFailed(exception: RequestRecordInput["exception"]): {
  exceptionType: string | null;
  exceptionFingerprint: string | null;
} {
  if (exception === undefined) {
    return { exceptionType: null, exceptionFingerprint: null };
  }
  return {
    exceptionType: exception.type,
    exceptionFingerprint: exception.fingerprint,
  };
}

/** The actor in force, or nobody — a request outside any context is anonymous. */
function whoAsked(
  actor: AuditActor | undefined,
): Pick<RequestRecord, "actorKind" | "actorId"> {
  if (actor === undefined) {
    return {
      actorKind: "anonymous",
      actorId: "",
    };
  }
  return {
    actorKind: actor.kind,
    actorId: actor.id,
  };
}

/** Nulls throughout for a response that never reached access enforcement. */
function whatAccessSettled(
  access: RequestAccessFacts | undefined,
): Pick<
  RequestRecord,
  "authMethod" | "accessKind" | "permission" | "resourceType" | "resourceId"
> {
  if (access === undefined) {
    return {
      authMethod: null,
      accessKind: null,
      permission: null,
      resourceType: null,
      resourceId: null,
    };
  }
  return {
    authMethod: access.authMethod ?? null,
    accessKind: access.accessKind,
    permission: access.permission ?? null,
    resourceType: access.resourceType ?? null,
    resourceId: access.resourceId ?? null,
  };
}

/** The allowlisted environment — the only place request headers are read. */
function whereItCameFrom(
  input: RequestRecordInput,
): Pick<
  RequestRecord,
  | "ip"
  | "forwardedFor"
  | "userAgent"
  | "clientHints"
  | "acceptLanguage"
  | "clientContext"
> {
  return {
    ip: input.ip ?? null,
    forwardedFor: headerValue(input.headers, FORWARDED_FOR_HEADER),
    userAgent: headerValue(input.headers, USER_AGENT_HEADER),
    clientHints: clientHintsOf(input.headers),
    acceptLanguage: headerValue(input.headers, ACCEPT_LANGUAGE_HEADER),
    clientContext: clientContextOf(input.headers),
  };
}

/**
 * Status plus access outcome, settled in one place.
 *
 * A server fault outranks everything — a 500 on an allowed route is an error,
 * not an allow. Below that, an access refusal is the more specific fact than
 * the status it produced, which is why `not-found` from enforcement becomes
 * `denied` while a plain 404 stays `not-found`.
 */
function resolveDecision(
  status: number,
  access: RequestAccessFacts | undefined,
): RequestDecision {
  if (status >= 500) return "error";
  if (access?.outcome === "unauthenticated" || status === 401) {
    return "unauthenticated";
  }
  if (access?.outcome === "not-found" || status === 403) return "denied";
  if (status === 404) return "not-found";
  if (status >= 400) return "error";
  return "allow";
}

/**
 * What `path` holds when Fastify matched no route — a 404, a 426 from the
 * client gate, a probe for someone else's software.
 *
 * The raw path is never stored: it may carry ids, and a route
 * pattern is exactly the thing that strips them. With no pattern to lean on,
 * every segment that could be an identifier is replaced, which keeps the
 * useful half of the answer — /api/orders/:id/lines says where the caller
 * went — without carrying the identifying half.
 */
function maskUnmatchedPath(url: string): string {
  const [rawPath = ""] = url.split("?");
  return rawPath
    .split("/")
    .map((segment) =>
      segment.length === 0 || NON_IDENTIFYING_SEGMENT.test(segment)
        ? segment
        : ":id",
    )
    .join("/");
}

/**
 * One allowlisted header, bounded. A repeated header yields its first
 * occurrence rather than a joined blob: the values here are diagnostic, and
 * the first is the one the client meant.
 */
function headerValue(
  headers: RequestRecordHeaders,
  name: string,
): string | null {
  const value = firstHeaderValue(headers[name]);
  if (value === undefined || value.length === 0) return null;
  return value.slice(0, MAX_HEADER_VALUE_LENGTH);
}

/** A repeated header arrives as an array; only its first occurrence is read. */
function firstHeaderValue(
  raw: string | readonly string[] | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  return typeof raw === "string" ? raw : raw[0];
}

/** Every `sec-ch-ua*` header and nothing else, or null when none were sent. */
function clientHintsOf(
  headers: RequestRecordHeaders,
): Record<string, string> | null {
  const hints: Record<string, string> = {};
  let kept = 0;
  for (const name of Object.keys(headers)) {
    if (!name.toLowerCase().startsWith(CLIENT_HINT_PREFIX)) continue;
    if (kept >= MAX_CLIENT_HINTS) break;
    const value = headerValue(headers, name);
    if (value === null) continue;
    hints[name.toLowerCase()] = value;
    kept += 1;
  }
  return kept === 0 ? null : hints;
}

/**
 * The client's self-reported environment. `decodeClientContext` swallows every
 * failure — missing, oversized, malformed, or a shape this build does not know
 * — so a debugging header can never decide whether a row is written.
 */
function clientContextOf(headers: RequestRecordHeaders): ClientContext | null {
  return decodeClientContext(firstHeaderValue(headers[CLIENT_CONTEXT_HEADER]));
}
