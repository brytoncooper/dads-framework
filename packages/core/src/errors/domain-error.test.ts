import { describe, expect, it } from "vitest";
import {
  conflict,
  DomainError,
  forbidden,
  isDomainError,
  notFound,
  validation,
} from "./domain-error.js";

/** What: DomainError discriminant + constructors. Why: kind in the constructor name. */

describe("DomainError", () => {
  it("carries the discriminant kind and stable code", () => {
    const error = new DomainError(
      "conflict",
      "ORGANIZATION_SLUG_TAKEN",
      'Organization slug "acme" is already taken',
      { slug: "acme" },
    );
    expect(error.kind).toBe("conflict");
    expect(error.code).toBe("ORGANIZATION_SLUG_TAKEN");
    expect(error.details).toEqual({ slug: "acme" });
    expect(error).toBeInstanceOf(Error);
  });

  it("narrows unknown errors with the type guard", () => {
    const domain: unknown = new DomainError("not-found", "X_NOT_FOUND", "x");
    const plain: unknown = new Error("boom");
    expect(isDomainError(domain)).toBe(true);
    expect(isDomainError(plain)).toBe(false);
  });
});

describe("shorthand constructors", () => {
  it.each([
    [notFound, "not-found"],
    [conflict, "conflict"],
    [validation, "validation"],
    [forbidden, "forbidden"],
  ] as const)("%o fixes the kind", (make, kind) => {
    const error = make("SOME_CODE", "message", { a: 1 });
    expect(error).toBeInstanceOf(DomainError);
    expect(error.kind).toBe(kind);
    expect(error.code).toBe("SOME_CODE");
    expect(error.details).toEqual({ a: 1 });
  });
});
