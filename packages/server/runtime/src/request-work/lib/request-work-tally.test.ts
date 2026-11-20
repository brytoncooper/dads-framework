/**
 * What: the tally reaches the right request, and only the right request.
 * Why: the counters run inside a pool and an authorization client that serve
 * every in-flight request at once, so "which request did this cost" is the one
 * thing this module has to get right. The concurrency and nesting cases below
 * are the failure modes that would silently misattribute work instead of
 * losing it loudly.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";

import {
  beginRequestWork,
  countAuthorizationCheck,
  countAuthorizationLookupSize,
  countAuthorizationReadFreshness,
  countDatabaseQuery,
  currentRequestWork,
  measureWork,
  noteAuthorizationWarning,
  requestWorkOf,
} from "./request-work-tally.js";

describe("request work tally", () => {
  it("starts at zero and is reachable both ways", () => {
    const request = {};

    beginRequestWork(request);

    expect(requestWorkOf(request)).toEqual({
      dbQueryCount: 0,
      dbMs: 0,
      authzCheckCount: 0,
      authzMs: 0,
      authzCachedReadCount: 0,
      authzFullyConsistentReadCount: 0,
      authzLargestLookupCount: 0,
      authzWarning: undefined,
    });
    expect(currentRequestWork()).toBe(requestWorkOf(request));
  });

  it("charges queries and checks to the request in context", () => {
    const request = {};
    beginRequestWork(request);

    countDatabaseQuery(12);
    countDatabaseQuery(8);
    countAuthorizationCheck(30);

    expect(requestWorkOf(request)).toMatchObject({
      dbQueryCount: 2,
      dbMs: 20,
      authzCheckCount: 1,
      authzMs: 30,
    });
  });

  it("charges each enforcement read's freshness to the request in context", async () => {
    const { tally } = await measureWork(() => {
      countAuthorizationReadFreshness("cached");
      countAuthorizationReadFreshness("cached");
      countAuthorizationReadFreshness("fully-consistent");
    });
    expect(tally.authzCachedReadCount).toBe(2);
    expect(tally.authzFullyConsistentReadCount).toBe(1);
    expect(() => {
      countAuthorizationReadFreshness("cached");
    }).not.toThrow();
  });

  it("keeps the largest lookup and the first warning the request tripped", async () => {
    const first = {
      type: "AuthorizationLookupOverWarningMark",
      fingerprint: "authz.lookup-size:test/thing#view",
      detail: "1200 ids",
    };
    const { tally } = await measureWork(() => {
      countAuthorizationLookupSize(40);
      countAuthorizationLookupSize(1_200);
      countAuthorizationLookupSize(3);
      noteAuthorizationWarning(first);
      noteAuthorizationWarning({ ...first, fingerprint: "authz.round-trips" });
    });
    expect(tally.authzLargestLookupCount).toBe(1_200);
    expect(tally.authzWarning).toEqual(first);
    expect(() => {
      countAuthorizationLookupSize(5);
      noteAuthorizationWarning(first);
    }).not.toThrow();
  });

  it("counts nothing, and throws nothing, outside a request", async () => {
    // A job, a migration, and the request-log sink's own flush all reach the
    // pool with no request behind them. They are not a request's cost.
    await measureWork(() => undefined);

    expect(() => {
      countDatabaseQuery(500);
      countAuthorizationCheck(500);
    }).not.toThrow();
    expect(currentRequestWork()).toBeUndefined();
  });

  it("keeps two interleaved requests apart", async () => {
    // The shape that matters: one pool, two requests, awaits between their
    // statements. Attribution follows the async task that issued the call.
    const slow = measureWork(async () => {
      countDatabaseQuery(1);
      await Promise.resolve();
      countDatabaseQuery(1);
      await Promise.resolve();
      countDatabaseQuery(1);
    });
    const fast = measureWork(async () => {
      await Promise.resolve();
      countDatabaseQuery(1);
    });

    const [slowRun, fastRun] = await Promise.all([slow, fast]);

    expect(slowRun.tally.dbQueryCount).toBe(3);
    expect(fastRun.tally.dbQueryCount).toBe(1);
  });

  it("survives a nested unrelated context", () => {
    // `carryResolvedAuditActor` re-enters the actor context mid-request. A
    // tally sharing that storage would lose everything counted before access
    // was enforced; a separate instance does not.
    const somebodyElsesContext = new AsyncLocalStorage<string>();
    const request = {};
    beginRequestWork(request);
    countDatabaseQuery(5);

    somebodyElsesContext.run("resolved-subject", () => {
      countDatabaseQuery(5);
    });

    expect(requestWorkOf(request)).toMatchObject({ dbQueryCount: 2, dbMs: 10 });
  });

  it("does not leak a measured scope into its caller", async () => {
    const request = {};
    beginRequestWork(request);

    await measureWork(() => {
      countDatabaseQuery(99);
    });
    countDatabaseQuery(1);

    expect(requestWorkOf(request)).toMatchObject({ dbQueryCount: 1, dbMs: 1 });
  });

  it("returns the measured work's own result", async () => {
    const { result, tally } = await measureWork(() => {
      countAuthorizationCheck(4);
      return "answer";
    });

    expect(result).toBe("answer");
    expect(tally.authzCheckCount).toBe(1);
  });
});
