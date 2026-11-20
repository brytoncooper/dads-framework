/**
 * What: the testing entry point reports the same counters production fills.
 * Why: a query budget asserted against a stand-in would pass while the real
 * request did something else. `measureRequestWork` runs the production
 * counters, so a budget is a claim about the shipped code.
 */

import { describe, expect, it } from "vitest";

import { chargeDatabaseQuery } from "./charge-request-work.js";
import { measureRequestWork } from "./measure-request-work.js";
import { countAuthorizationCheck } from "./request-work-tally.js";

describe("measureRequestWork", () => {
  it("reports what the work cost", async () => {
    const tally = await measureRequestWork(async () => {
      await chargeDatabaseQuery(() => undefined);
      countAuthorizationCheck(7);
    });

    expect(tally).toMatchObject({ dbQueryCount: 1, authzCheckCount: 1 });
  });

  it("reports zero for work that touched nothing", async () => {
    const tally = await measureRequestWork(() => "pure");

    expect(tally).toEqual({
      dbQueryCount: 0,
      dbMs: 0,
      authzCheckCount: 0,
      authzMs: 0,
      authzCachedReadCount: 0,
      authzFullyConsistentReadCount: 0,
      authzLargestLookupCount: 0,
      authzWarning: undefined,
    });
  });
});
