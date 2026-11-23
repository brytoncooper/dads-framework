import { describe, expect, it } from "vitest";
import { DomainError } from "./domain-error.js";
import { mapErrorToHttpResponse } from "./map-error-to-http-response.js";

/** What: kind→status table and masked 500. Why: one mapping, no leaked internals. */

describe("mapErrorToHttpResponse", () => {
  it.each([
    ["validation", 400],
    ["forbidden", 403],
    ["not-found", 404],
    ["conflict", 409],
  ] as const)("maps DomainError kind %s to %d", (kind, status) => {
    const mapped = mapErrorToHttpResponse(new DomainError(kind, "SOME_CODE", "message"), "req-1");
    expect(mapped.status).toBe(status);
    expect(mapped.unexpected).toBe(false);
    expect(mapped.body).toEqual({
      error: { code: "SOME_CODE", message: "message" },
    });
  });

  it("carries domain error details", () => {
    const mapped = mapErrorToHttpResponse(
      new DomainError("conflict", "ORGANIZATION_SLUG_TAKEN", "taken", {
        slug: "acme",
      }),
      "req-1",
    );
    expect(mapped.body.error.details).toEqual({ slug: "acme" });
  });

  it("hides internals on unknown errors and echoes the request id", () => {
    const mapped = mapErrorToHttpResponse(new Error("secret stack detail"), "req-9");
    expect(mapped.status).toBe(500);
    expect(mapped.unexpected).toBe(true);
    expect(mapped.body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
        requestId: "req-9",
      },
    });
  });
});
