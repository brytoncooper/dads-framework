/**
 * What: charging a call never changes what the caller sees, and a failure is
 * charged like a success.
 * Why: these wrappers sit directly in the path of every database statement and
 * every permission check. A wrapper that swallowed a rejection, altered an
 * error, or skipped the slow-then-failed case would corrupt both the stack
 * traces and the very numbers the columns exist to report.
 */

import { describe, expect, it } from "vitest";

import { chargeAuthorizationCheck, chargeDatabaseQuery } from "./charge-request-work.js";
import { measureWork } from "./request-work-tally.js";

describe("charging request work", () => {
  it("returns the call's value untouched", async () => {
    const { result } = await measureWork(async () => chargeDatabaseQuery(() => ({ rows: [1, 2, 3] })));

    expect(result).toEqual({ rows: [1, 2, 3] });
  });

  it("charges a query that succeeded", async () => {
    const { tally } = await measureWork(async () => {
      await chargeDatabaseQuery(() => undefined);
      await chargeDatabaseQuery(() => undefined);
    });

    expect(tally.dbQueryCount).toBe(2);
    expect(tally.dbMs).toBeGreaterThanOrEqual(0);
  });

  it("charges a query that failed, and rethrows the original error", async () => {
    // A statement that ran for 800ms and then threw still cost the request
    // 800ms. Dropping it would make the slowest requests look the cheapest.
    const failure = new Error("deadlock detected");

    const { tally } = await measureWork(async () => {
      await expect(
        chargeDatabaseQuery(() => {
          throw failure;
        }),
      ).rejects.toBe(failure);
    });

    expect(tally.dbQueryCount).toBe(1);
  });

  it("charges authorization calls separately from queries", async () => {
    const { tally } = await measureWork(async () => {
      await chargeDatabaseQuery(() => undefined);
      await chargeAuthorizationCheck(() => true);
      await chargeAuthorizationCheck(() => false);
    });

    expect(tally).toMatchObject({ dbQueryCount: 1, authzCheckCount: 2 });
  });

  it("charges an authorization call that failed", async () => {
    const failure = new Error("spicedb unavailable");

    const { tally } = await measureWork(async () => {
      await expect(
        chargeAuthorizationCheck(() => {
          throw failure;
        }),
      ).rejects.toBe(failure);
    });

    expect(tally.authzCheckCount).toBe(1);
  });

  it("is inert outside a request", async () => {
    await expect(chargeDatabaseQuery(() => "fine")).resolves.toBe("fine");
  });
});
