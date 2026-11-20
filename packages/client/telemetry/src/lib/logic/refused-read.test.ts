import { describe, expect, it } from "vitest";

import type { ApiExchange } from "@dads-framework/client-request-transport";

import { refusedReadOf } from "./refused-read.js";

const SETTINGS_READ: ApiExchange = {
  method: "GET",
  path: "/api/organizations/0192f6a4-1c2b-7d3e-8f40-123456789abc/settings",
  status: 404,
  requestId: "r1",
  durationMs: 12,
  refusedForAccess: true,
};

describe("refusedReadOf", () => {
  it("reports a refused read with its ids folded away", () => {
    expect(refusedReadOf(SETTINGS_READ)?.message).toBe(
      "Refused read: GET /api/organizations/:id/settings answered a marked 404 to a page its user opened (or the record was removed since the page loaded)",
    );
  });

  it("leaves an unmarked missing record, a refused write and a success alone", () => {
    expect(refusedReadOf({ ...SETTINGS_READ, refusedForAccess: false })).toBe(
      null,
    );
    expect(refusedReadOf({ ...SETTINGS_READ, method: "PUT" })).toBe(null);
    expect(
      refusedReadOf({ ...SETTINGS_READ, status: 200, refusedForAccess: false }),
    ).toBe(null);
  });
});
