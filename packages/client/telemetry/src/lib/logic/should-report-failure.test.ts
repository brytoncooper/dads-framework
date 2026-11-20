/**
 * What: faults are reported, refusals are not.
 * Why: this predicate is the difference between a telemetry stream someone
 * reads and one nobody does. A stream full of 404s and offline blips costs
 * more than having none at all, because it teaches the team to ignore it.
 * Every row of the table is pinned here so widening it is a deliberate act.
 */

import { describe, expect, it } from "vitest";

import {
  ApiError,
  NetworkError,
  UnauthorizedError,
} from "@dads-framework/client-request-transport";

import { shouldReportFailure } from "./should-report-failure.js";

describe("shouldReportFailure", () => {
  it("ignores an expired session", () => {
    // Already handled end to end by returning the user to login.
    expect(
      shouldReportFailure(new UnauthorizedError("UNAUTHENTICATED", "no")),
    ).toBe("ignore");
  });

  it("ignores every 4xx, because the API said no on purpose", () => {
    expect(shouldReportFailure(new ApiError(404, "NOT_FOUND", "x"))).toBe(
      "ignore",
    );
    expect(shouldReportFailure(new ApiError(403, "FORBIDDEN", "x"))).toBe(
      "ignore",
    );
    expect(shouldReportFailure(new ApiError(409, "CONFLICT", "x"))).toBe(
      "ignore",
    );
    expect(
      shouldReportFailure(new ApiError(429, "TOO_MANY_REQUESTS", "x")),
    ).toBe("ignore");
  });

  it("reports a 5xx, because that is the server failing", () => {
    expect(shouldReportFailure(new ApiError(500, "INTERNAL_ERROR", "x"))).toBe(
      "report",
    );
    expect(
      shouldReportFailure(new ApiError(503, "SERVICE_UNAVAILABLE", "x")),
    ).toBe("report");
  });

  it("keeps a network failure as context, not as an event", () => {
    // Kiosks and plant-local deployments are offline by design.
    expect(shouldReportFailure(new NetworkError(new TypeError("x")))).toBe(
      "breadcrumb",
    );
  });

  it("ignores an aborted request", () => {
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    expect(shouldReportFailure(aborted)).toBe("ignore");
  });

  it("reports everything else, including a thrown non-error", () => {
    expect(
      shouldReportFailure(new TypeError("undefined is not a function")),
    ).toBe("report");
    expect(shouldReportFailure("a thrown string")).toBe("report");
  });
});
