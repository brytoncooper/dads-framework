import { describe, expect, it } from "vitest";

import { isRetryableSpiceDbWriteError, spiceDbWriteRetryDelayMs } from "./spice-db-write-retry.js";

function withCode(code: unknown): Error {
  return Object.assign(new Error("grpc"), { code });
}

describe("isRetryableSpiceDbWriteError", () => {
  it.each([
    { name: "DEADLINE_EXCEEDED", code: 4 },
    { name: "ABORTED", code: 10 },
    { name: "UNAVAILABLE", code: 14 },
  ])("retries $name, a write that lost a race", ({ code }) => {
    expect(isRetryableSpiceDbWriteError(withCode(code))).toBe(true);
  });

  it.each([
    { name: "INVALID_ARGUMENT", code: 3 },
    { name: "FAILED_PRECONDITION", code: 9 },
    { name: "PERMISSION_DENIED", code: 7 },
    { name: "a string code", code: "4" },
  ])("does not retry $name, a refusal", ({ code }) => {
    expect(isRetryableSpiceDbWriteError(withCode(code))).toBe(false);
  });

  it("does not retry an error without a status code", () => {
    expect(isRetryableSpiceDbWriteError(new Error("boom"))).toBe(false);
    expect(isRetryableSpiceDbWriteError("boom")).toBe(false);
    expect(isRetryableSpiceDbWriteError(null)).toBe(false);
  });
});

describe("spiceDbWriteRetryDelayMs", () => {
  it("doubles from 10 ms", () => {
    expect([1, 2, 3].map(spiceDbWriteRetryDelayMs)).toEqual([10, 20, 40]);
  });
});
