import { describe, expect, it } from "vitest";

import { decodeFilterParam, encodeFilterParam } from "./filter-param.js";

describe("encodeFilterParam", () => {
  it("leaves the param off an unfiltered table", () => {
    expect(encodeFilterParam([])).toBeUndefined();
  });

  it("writes a filter on its column's default operator as column and value", () => {
    expect(encodeFilterParam([{ id: "status", value: "ACTIVE" }])).toBe("status.ACTIVE");
  });

  it("spells the operator out when it is not the default", () => {
    expect(encodeFilterParam([{ id: "createdAt", operator: "gte", value: "2026-01-01" }])).toBe(
      "createdAt.gte.2026-01-01",
    );
  });

  it("joins several accepted values with commas", () => {
    expect(encodeFilterParam([{ id: "status", value: ["ACTIVE", "ARCHIVED"] }])).toBe("status.ACTIVE,ARCHIVED");
  });

  it("separates several filters with a star", () => {
    expect(
      encodeFilterParam([
        { id: "status", value: "ACTIVE" },
        { id: "name", value: "feeds" },
      ]),
    ).toBe("status.ACTIVE*name.feeds");
  });

  it("keeps the value slot for an operator that takes no value", () => {
    expect(encodeFilterParam([{ id: "note", operator: "isEmpty", value: "" }])).toBe("note.isEmpty.");
  });

  it("leaves dots inside a value alone — they need no escape", () => {
    expect(encodeFilterParam([{ id: "name", value: "test.org" }])).toBe("name.test.org");
  });
});

describe("decodeFilterParam", () => {
  it("reads a column and value as the column's default operator", () => {
    expect(decodeFilterParam("status.ACTIVE")).toEqual([{ id: "status", value: "ACTIVE" }]);
  });

  it("reads a spelled-out operator", () => {
    expect(decodeFilterParam("createdAt.gte.2026-01-01")).toEqual([
      { id: "createdAt", operator: "gte", value: "2026-01-01" },
    ]);
  });

  it("reads a comma list as several accepted values", () => {
    expect(decodeFilterParam("status.ACTIVE,ARCHIVED")).toEqual([{ id: "status", value: ["ACTIVE", "ARCHIVED"] }]);
  });

  it("reads several filters", () => {
    expect(decodeFilterParam("status.ACTIVE*name.feeds")).toEqual([
      { id: "status", value: "ACTIVE" },
      { id: "name", value: "feeds" },
    ]);
  });

  it("keeps a value that contains dots whole", () => {
    expect(decodeFilterParam("name.test.org")).toEqual([{ id: "name", value: "test.org" }]);
  });

  it("drops tokens that name no value", () => {
    expect(decodeFilterParam("")).toEqual([]);
    expect(decodeFilterParam("status")).toEqual([]);
    expect(decodeFilterParam("**")).toEqual([]);
    expect(decodeFilterParam("status.ACTIVE**")).toEqual([{ id: "status", value: "ACTIVE" }]);
  });

  it("reads a middle word that names no operator as part of the value", () => {
    expect(decodeFilterParam("name.notAnOperator.x")).toEqual([{ id: "name", value: "notAnOperator.x" }]);
  });
});

describe("filter param escaping", () => {
  const roundTrips = (filters: Parameters<typeof encodeFilterParam>[0], expected: string) => {
    const encoded = encodeFilterParam(filters);
    expect(encoded).toBe(expected);
    expect(decodeFilterParam(encoded ?? "")).toEqual(filters);
  };

  it("round-trips a value containing the value separator", () => {
    roundTrips([{ id: "name", value: "Smith, Jones" }], "name.Smith\\, Jones");
  });

  it("round-trips a value containing the filter separator", () => {
    roundTrips([{ id: "name", value: "2 * 3" }], "name.2 \\* 3");
  });

  it("round-trips a value containing a backslash", () => {
    roundTrips([{ id: "path", value: "a\\b" }], "path.a\\\\b");
  });

  it("round-trips a value whose first dotted word looks like an operator", () => {
    roundTrips([{ id: "name", value: "gte.foo" }], "name.gte\\.foo");
  });

  it("round-trips a column id containing a dot", () => {
    roundTrips([{ id: "a.b", value: "x" }], "a\\.b.x");
  });

  it("round-trips every separator at once, across two filters", () => {
    roundTrips(
      [
        { id: "name", value: ["a,b", "c*d"] },
        { id: "note", operator: "ne", value: "e\\f" },
      ],
      "name.a\\,b,c\\*d*note.ne.e\\\\f",
    );
  });
});
