import { describe, expect, it } from "vitest";
import { DomainError } from "./domain-error.js";
import { err, ok, unwrap, type Result } from "./result.js";

/** What: Result ok/err/unwrap. Why: expected failures stay values until the HTTP edge. */

function halve(n: number): Result<number> {
  if (n % 2 !== 0) {
    return err(new DomainError("validation", "NOT_EVEN", `${n} is not even`));
  }
  return ok(n / 2);
}

describe("Result", () => {
  it("branches on the ok discriminant", () => {
    const success = halve(4);
    expect(success.ok).toBe(true);
    if (success.ok) {
      expect(success.value).toBe(2);
    }

    const failure = halve(3);
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.error.code).toBe("NOT_EVEN");
      expect(failure.error.kind).toBe("validation");
    }
  });

  it("unwrap returns the value on success", () => {
    expect(unwrap(halve(10))).toBe(5);
  });

  it("unwrap throws the typed error on failure", () => {
    expect(() => unwrap(halve(7))).toThrow(DomainError);
  });
});
