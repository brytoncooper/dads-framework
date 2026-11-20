/**
 * What: discriminated-union members are written in tag order and string
 * enums in value order; other lists keep theirs; two names added at the
 * same declared spot land apart.
 * Why: a union and an enum of names that grow by one name per pull request
 * would, in declaration order, put two PRs' names on the same line of a
 * committed document.
 */
import { describe, expect, it } from "vitest";

import { withListsInNameOrder } from "./list-order.js";

function member(type: string, extra: Record<string, unknown> = {}) {
  return {
    type: "object",
    properties: {
      op: { type: "string", enum: ["upsert"] },
      type: { type: "string", enum: [type] },
      ...extra,
    },
  };
}

describe("withListsInNameOrder", () => {
  it("orders a string enum by value and leaves other enums and lists alone", () => {
    const document = {
      enum: ["ticket", "customer", "order"],
      properties: {
        level: { enum: [3, 1, 2] },
        required: ["zeta", "alpha"],
      },
    };

    expect(withListsInNameOrder(document)).toEqual({
      enum: ["customer", "order", "ticket"],
      properties: {
        level: { enum: [3, 1, 2] },
        required: ["zeta", "alpha"],
      },
    });
  });

  it("orders a union's members by the value that tells them apart", () => {
    const union = {
      oneOf: [member("tickets"), member("customers"), member("orders")],
    };

    expect(withListsInNameOrder(union)).toEqual({
      oneOf: [member("customers"), member("orders"), member("tickets")],
    });
  });

  it("reorders unions nested anywhere, and reads const as a pinned value", () => {
    const document = {
      paths: {
        "/feed": {
          get: {
            anyOf: [
              { properties: { kind: { const: "b" } } },
              { properties: { kind: { const: "a" } } },
            ],
          },
        },
      },
    };

    expect(withListsInNameOrder(document)).toEqual({
      paths: {
        "/feed": {
          get: {
            anyOf: [
              { properties: { kind: { const: "a" } } },
              { properties: { kind: { const: "b" } } },
            ],
          },
        },
      },
    });
  });

  it("keeps the order of a list whose members share no distinct tag", () => {
    const untagged = {
      oneOf: [{ type: "string" }, { type: "number" }, member("x")],
    };
    const sameTag = { oneOf: [member("x"), member("x")] };

    expect(withListsInNameOrder(untagged)).toEqual(untagged);
    expect(withListsInNameOrder(sameTag)).toEqual(sameTag);
  });

  it("does not change the input", () => {
    const union = { oneOf: [member("b"), member("a")] };
    withListsInNameOrder(union);
    expect(union.oneOf[0]).toEqual(member("b"));
  });

  it("puts two members appended at the same declared spot apart when their tags sort apart", () => {
    const existing = ["batch", "customer", "order", "ticket"].map((type) =>
      member(type),
    );
    const fromFirstPr = withListsInNameOrder({
      oneOf: [...existing, member("audit_entry")],
    });
    const fromSecondPr = withListsInNameOrder({
      oneOf: [...existing, member("zone")],
    });

    expect(fromFirstPr).toHaveProperty(["oneOf", 0], member("audit_entry"));
    expect(fromSecondPr).toHaveProperty(["oneOf", 4], member("zone"));
  });
});
