/**
 * What: a fault reads as one line, most important thing first.
 * Why: this arrives unasked-for and is often read on a phone. Someone who
 * stops after two words should still know whether it is their problem.
 */

import { describe, expect, it } from "vitest";

import { describeFaultLine } from "./describe-fault-line.js";

describe("describeFaultLine", () => {
  it("leads with what failed and where it came from", () => {
    expect(
      describeFaultLine({
        fingerprint: "a1b2c3d4",
        type: "TypeError",
        occurrences: 3,
        where: "/api/orders",
        origin: "server",
      }),
    ).toBe("TypeError (server) — 3 occurrences at /api/orders · a1b2c3d4");
  });

  it("says occurrence, not occurrences, when there was one", () => {
    expect(
      describeFaultLine({
        fingerprint: "a1b2c3d4",
        type: "render",
        occurrences: 1,
        where: null,
        origin: "client",
      }),
    ).toBe("render (client) — 1 occurrence · a1b2c3d4");
  });

  it("drops the location rather than printing a hole", () => {
    expect(
      describeFaultLine({
        fingerprint: "deadbeef",
        type: "ZodError",
        occurrences: 9,
        where: null,
        origin: "client",
      }),
    ).not.toContain("null");
  });
});
