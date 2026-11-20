import { describe, expect, it } from "vitest";
import { copy, isCopyDescriptor } from "./copy-descriptor.js";

/**
 * What: the unresolved sentence `copy()` builds — key, vars, count — and the
 * guard that tells one from an ordinary interpolation value.
 * Why: a sentence that fills a slot in another sentence has to stay unresolved
 * until the locale is known. Resolve it at the call site and the outer sentence
 * interpolates finished text, so the inner one can never agree with its own
 * count in a language whose plural rules differ from English.
 */

describe("copy", () => {
  it("names a sentence and nothing else when nothing fills it", () => {
    expect(copy("orders.empty")).toEqual({ key: "orders.empty" });
  });

  it("carries what fills the sentence", () => {
    expect(copy("orders.at", { facility: "Cedar Rapids" })).toEqual({
      key: "orders.at",
      vars: { facility: "Cedar Rapids" },
    });
  });

  it("carries the number a sentence pluralizes on", () => {
    expect(copy("permissions.holders", {}, 3)).toEqual({
      key: "permissions.holders",
      vars: {},
      count: 3,
    });
  });

  it("keeps a nested sentence as a sentence, not as text", () => {
    const nested = copy("permissions.holders", {}, 1);

    expect(copy("permissions.summary", { holders: nested }).vars).toEqual({
      holders: { key: "permissions.holders", vars: {}, count: 1 },
    });
  });
});

describe("isCopyDescriptor", () => {
  it("recognizes a descriptor", () => {
    expect(isCopyDescriptor(copy("orders.empty"))).toBe(true);
  });

  it("refuses everything a var may otherwise hold", () => {
    for (const value of ["orders.empty", 7, null, undefined, {}, { key: 1 }]) {
      expect(isCopyDescriptor(value)).toBe(false);
    }
  });
});
