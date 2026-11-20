/**
 * What/why: a hot caller trips the same authorization warning on every
 * request; recording each one would bury the alert. A warning is recorded
 * once per hour per route, and two routes are two faults.
 */
import { describe, expect, it } from "vitest";

import { AuthorizationWarningFaults } from "./authorization-warning-faults.js";

const warning = {
  type: "AuthorizationRoundTripsOverBudget",
  fingerprint: "authz.round-trips",
  detail: "request made more than 50 authorization round trips",
};
const HOUR = 60 * 60 * 1000;

describe("AuthorizationWarningFaults", () => {
  it("records a warning once per hour per route", () => {
    const faults = new AuthorizationWarningFaults();
    expect(faults.recordable(warning, "/a", 0)).toEqual({
      type: "AuthorizationRoundTripsOverBudget",
      fingerprint: "authz.round-trips@/a",
    });
    expect(faults.recordable(warning, "/a", HOUR - 1)).toBeUndefined();
    expect(faults.recordable(warning, "/b", HOUR - 1)).toEqual({
      type: "AuthorizationRoundTripsOverBudget",
      fingerprint: "authz.round-trips@/b",
    });
    expect(faults.recordable(warning, "/a", HOUR)).toBeDefined();
    expect(faults.recordable(warning, undefined, 0)?.fingerprint).toBe(
      "authz.round-trips@unmatched",
    );
  });
});
