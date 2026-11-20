import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "./unique-violation.js";

/** pg 23505 detection, including drizzle-orm's wrapped `cause` chain. */
describe("isUniqueViolation", () => {
  it("detects a bare pg unique-violation error (code 23505)", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("walks drizzle's cause chain to the wrapped pg error", () => {
    const wrapped = new Error("Failed query", { cause: { code: "23505" } });
    expect(isUniqueViolation(wrapped)).toBe(true);

    const doubleWrapped = new Error("outer", { cause: wrapped });
    expect(isUniqueViolation(doubleWrapped)).toBe(true);
  });

  it("rejects other pg codes, plain errors, and non-objects", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  it("survives cause cycles without recursing forever", () => {
    const a: { cause?: unknown } = {};
    const b: { cause?: unknown } = { cause: a };
    a.cause = b;
    expect(isUniqueViolation(a)).toBe(false);
  });
});
