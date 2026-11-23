import { describe, expect, it } from "vitest";
import { DEFAULT_LEASE_MS, leaseCutoff, outcomeAfterFailure, summarizeError } from "./claim-rules.js";

const NOW = new Date("2026-08-03T12:00:00.000Z");

describe("leaseCutoff", () => {
  it("is one lease behind now", () => {
    expect(leaseCutoff(NOW, 60_000)).toEqual(new Date("2026-08-03T11:59:00.000Z"));
  });

  it("defaults to the documented lease rather than to zero", () => {
    // A zero default would make every in-flight claim instantly stealable,
    // so two workers would project the same fact on every run.
    expect(leaseCutoff(NOW)).toEqual(new Date(NOW.getTime() - DEFAULT_LEASE_MS));
  });
});

describe("outcomeAfterFailure", () => {
  it("returns a row to PENDING while attempts remain", () => {
    expect(outcomeAfterFailure(0, 5)).toEqual({
      status: "PENDING",
      attempts: 1,
    });
    expect(outcomeAfterFailure(3, 5)).toEqual({
      status: "PENDING",
      attempts: 4,
    });
  });

  it("gives up at the limit and leaves the row visible as FAILED", () => {
    expect(outcomeAfterFailure(4, 5)).toEqual({
      status: "FAILED",
      attempts: 5,
    });
  });

  it("never retries past the limit, even for a row that somehow exceeded it", () => {
    expect(outcomeAfterFailure(9, 5)).toEqual({
      status: "FAILED",
      attempts: 10,
    });
  });

  it("a limit of one fails on the first attempt", () => {
    expect(outcomeAfterFailure(0, 1)).toEqual({
      status: "FAILED",
      attempts: 1,
    });
  });
});

describe("summarizeError", () => {
  it("keeps a short message as-is", () => {
    expect(summarizeError(new Error("permission denied"))).toBe("permission denied");
  });

  it("survives a thrown non-Error", () => {
    expect(summarizeError("plain string failure")).toBe("plain string failure");
  });

  it("truncates rather than letting an adapter dump fill the column", () => {
    const summary = summarizeError(new Error("x".repeat(900)), 100);
    expect(summary).toHaveLength(100);
    expect(summary.endsWith("…")).toBe(true);
  });
});
