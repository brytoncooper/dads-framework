/**
 * How much work one request actually cost.
 *
 * `request_log.duration_ms` says a request took 900ms; it has never said why.
 * This is the missing half: a small mutable tally per request, incremented by
 * the two seams every request already passes through — the attributed pool's
 * connection checkout and the `Authorization` port — and read back at
 * `onResponse` into columns. Three queries at 300ms and three hundred queries
 * at 3ms are the same row today and different rows after this.
 *
 * The tally is reachable two ways on purpose:
 *
 * - **By async context**, for the counters. One `pg.Pool` and one
 *   `Authorization` serve every request at once, so neither has a request in
 *   hand when it does the work. Reading the context AT THE MOMENT OF THE CALL
 *   is what makes the attribution right: a checkout is ambiguous — a client
 *   can be held across awaits — but the statement that runs on it was issued
 *   by exactly one async task, and that task belongs to one request.
 * - **By request object**, for the capture. `onResponse` needs the tally of
 *   the request that just answered, not of whatever async task happens to be
 *   current when Fastify calls the hook. A `WeakMap` keyed on the request
 *   gives that deterministically, and mirrors how `request-outcome.ts` already
 *   keeps its notes.
 *
 * Its own `AsyncLocalStorage`, not the audit actor's: the actor context is
 * re-entered mid-request once the subject resolves (`carryResolvedAuditActor`),
 * and a tally that got replaced there would lose everything counted before
 * access was enforced.
 *
 * Nothing here can fail a request. Work done outside any request — jobs, the
 * request-log sink's own flush, migrations — finds no tally and is counted
 * nowhere, which is correct: those are not a request's cost.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The tally as everything outside this file sees it: numbers to read, never
 * to assign. Only {@link countDatabaseQuery}, {@link countAuthorizationCheck},
 * {@link countAuthorizationReadFreshness},
 * {@link countAuthorizationLookupSize} and {@link noteAuthorizationWarning}
 * move them, so "what can change this row" is a property of five functions
 * rather than of every importer.
 */
export type RequestWorkTally = {
  /** Statements issued on a pooled connection, the actor stamp excluded. */
  readonly dbQueryCount: number;
  /** Wall time inside those statements. Overlaps itself when they run concurrently. */
  readonly dbMs: number;
  /** `check` and `lookupResources` calls that reached the authorization vendor. */
  readonly authzCheckCount: number;
  /** Wall time inside those calls. Overlaps itself the same way. */
  readonly authzMs: number;
  /**
   * Enforcement reads the vendor was allowed to answer from its cache
   * (SpiceDB `at_least_as_fresh` the server's newest write).
   */
  readonly authzCachedReadCount: number;
  /** Enforcement reads sent fully consistent, which bypass the vendor's cache. */
  readonly authzFullyConsistentReadCount: number;
  /**
   * The most ids any one `lookupResources` returned. A list that asks for
   * every visible id shows here as it grows, long before it is slow.
   */
  readonly authzLargestLookupCount: number;
  /**
   * The first authorization guard this request tripped without failing (a
   * lookup past the warning mark, too many round trips), or `undefined`. The
   * request row records it as a fault.
   */
  readonly authzWarning: AuthorizationWarning | undefined;
};

/**
 * An authorization guard the request tripped while still succeeding. Type and
 * fingerprint group it like an exception; `detail` names wire types,
 * permissions and counts only, never an id or a name.
 */
export type AuthorizationWarning = {
  readonly type: string;
  readonly fingerprint: string;
  readonly detail: string;
};

/** How fresh the authorization vendor was asked to be for one enforcement read. */
export type AuthorizationReadFreshness = "cached" | "fully-consistent";

/** The same object, from the inside, where the counters live. */
type CountingTally = {
  dbQueryCount: number;
  dbMs: number;
  authzCheckCount: number;
  authzMs: number;
  authzCachedReadCount: number;
  authzFullyConsistentReadCount: number;
  authzLargestLookupCount: number;
  authzWarning: AuthorizationWarning | undefined;
};

const requestWork = new AsyncLocalStorage<CountingTally>();
const talliesByRequest = new WeakMap<object, CountingTally>();

/**
 * Starts a tally for `request` and makes it current for everything the request
 * goes on to do.
 *
 * `enterWith` rather than `run`, for the reason `enterAuditActor` gives: a
 * Fastify request is a chain of separate hook callbacks, so ingress cannot
 * wrap what comes after it — the hook has to return. The context is never
 * left; the next request's ingress replaces it.
 */
export function beginRequestWork(request: object): void {
  const tally = emptyTally();
  talliesByRequest.set(request, tally);
  requestWork.enterWith(tally);
}

/**
 * The tally the current async task belongs to, or `undefined` outside any
 * request. Both counters call this; neither creates one, so work with no
 * request behind it stays uncounted rather than inventing a request.
 */
export function currentRequestWork(): RequestWorkTally | undefined {
  return requestWork.getStore();
}

/** The tally `request` accrued, for the capture at `onResponse`. */
export function requestWorkOf(request: object): RequestWorkTally | undefined {
  return talliesByRequest.get(request);
}

/** Charges one database statement, taking `elapsedMs`, to the current request. */
export function countDatabaseQuery(elapsedMs: number): void {
  const tally = requestWork.getStore();
  if (tally === undefined) return;
  tally.dbQueryCount += 1;
  tally.dbMs += elapsedMs;
}

/** Charges one authorization call, taking `elapsedMs`, to the current request. */
export function countAuthorizationCheck(elapsedMs: number): void {
  const tally = requestWork.getStore();
  if (tally === undefined) return;
  tally.authzCheckCount += 1;
  tally.authzMs += elapsedMs;
}

/**
 * Charges one enforcement read's freshness to the current request. The
 * vendor adapter reports it at the moment it sends the read, so the async
 * context is the caller's and the read lands on the request that asked.
 */
export function countAuthorizationReadFreshness(freshness: AuthorizationReadFreshness): void {
  const tally = requestWork.getStore();
  if (tally === undefined) return;
  if (freshness === "cached") tally.authzCachedReadCount += 1;
  else tally.authzFullyConsistentReadCount += 1;
}

/**
 * Keeps the largest id count one `lookupResources` returned on the current
 * request, so the request row shows how close its lists are to the marks.
 */
export function countAuthorizationLookupSize(idCount: number): void {
  const tally = requestWork.getStore();
  if (tally === undefined) return;
  tally.authzLargestLookupCount = Math.max(tally.authzLargestLookupCount, idCount);
}

/**
 * Notes an authorization guard the current request tripped without failing.
 * The first one is kept: the row has one fault slot, and the first is the
 * cause more often than what followed it.
 */
export function noteAuthorizationWarning(warning: AuthorizationWarning): void {
  const tally = requestWork.getStore();
  if (tally === undefined || tally.authzWarning !== undefined) return;
  tally.authzWarning = warning;
}

function emptyTally(): CountingTally {
  return {
    dbQueryCount: 0,
    dbMs: 0,
    authzCheckCount: 0,
    authzMs: 0,
    authzCachedReadCount: 0,
    authzFullyConsistentReadCount: 0,
    authzLargestLookupCount: 0,
    authzWarning: undefined,
  };
}

/**
 * Runs `work` inside a fresh tally and hands back what it cost.
 *
 * Shared by the testing entry point and by anything that wants a bounded
 * measurement of its own. `run` rather than `enterWith`: a caller that asked
 * for one measurement gets exactly that scope back when it ends.
 */
export async function measureWork<T>(
  work: () => Promise<T> | T,
): Promise<{ readonly result: T; readonly tally: RequestWorkTally }> {
  const tally = emptyTally();
  const result = await requestWork.run(tally, async () => work());
  return { result, tally };
}
