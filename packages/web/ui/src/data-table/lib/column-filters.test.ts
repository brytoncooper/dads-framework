import { describe, expect, it } from "vitest";

import { toColumnFilters, toUrlFilters } from "./column-filters.js";
import type { FilterVariant } from "./data-table-types.js";

type Organization = { name: string; status: string; createdAt: string };

const columnVariants = new Map<string, FilterVariant>([
  ["name", "text"],
  ["status", "select"],
  ["createdAt", "date"],
]);

describe("toColumnFilters", () => {
  it("takes the variant from the column, never from the URL", () => {
    const [filter] = toColumnFilters<Organization>(
      [{ id: "status", value: "ACTIVE", variant: "text" }],
      columnVariants,
    );

    expect(filter?.variant).toBe("select");
  });

  it("falls back to the column's default operator when the URL omits one", () => {
    const [text] = toColumnFilters<Organization>(
      [{ id: "name", value: "feeds" }],
      columnVariants,
    );
    const [select] = toColumnFilters<Organization>(
      [{ id: "status", value: "ACTIVE" }],
      columnVariants,
    );

    expect(text?.operator).toBe("iLike");
    expect(select?.operator).toBe("eq");
  });

  it("keeps an operator the URL spelled out", () => {
    const [filter] = toColumnFilters<Organization>(
      [{ id: "createdAt", operator: "gte", value: "2026-01-01" }],
      columnVariants,
    );

    expect(filter?.operator).toBe("gte");
  });

  it("gives a chooser column its value as a list", () => {
    const [filter] = toColumnFilters<Organization>(
      [{ id: "status", value: "ACTIVE" }],
      columnVariants,
    );

    expect(filter?.value).toEqual(["ACTIVE"]);
  });

  it("gives a typed-into column its value as text", () => {
    const [filter] = toColumnFilters<Organization>(
      [{ id: "name", value: ["feeds"] }],
      columnVariants,
    );

    expect(filter?.value).toBe("feeds");
  });

  it("drops a filter on a column this table does not have", () => {
    expect(
      toColumnFilters<Organization>(
        [
          { id: "somethingElse", value: "x" },
          { id: "name", value: "feeds" },
        ],
        columnVariants,
      ).map((filter) => filter.id),
    ).toEqual(["name"]);
  });

  it("names each filter row the same way every render", () => {
    const filters = [
      { id: "name", value: "a" },
      { id: "name", operator: "ne" as const, value: "b" },
    ];

    const first = toColumnFilters<Organization>(filters, columnVariants);
    const second = toColumnFilters<Organization>(filters, columnVariants);

    expect(first.map((filter) => filter.filterId)).toEqual(
      second.map((filter) => filter.filterId),
    );
    expect(new Set(first.map((filter) => filter.filterId)).size).toBe(2);
  });
});

describe("toUrlFilters", () => {
  it("drops the operator when it is the column's default", () => {
    expect(
      toUrlFilters<Organization>(
        [
          {
            id: "status",
            value: ["ACTIVE"],
            variant: "select",
            operator: "eq",
            filterId: "status",
          },
        ],
        columnVariants,
      ),
    ).toEqual([{ id: "status", value: ["ACTIVE"] }]);
  });

  it("keeps an operator the reader chose", () => {
    expect(
      toUrlFilters<Organization>(
        [
          {
            id: "createdAt",
            value: "2026-01-01",
            variant: "date",
            operator: "gte",
            filterId: "createdAt",
          },
        ],
        columnVariants,
      ),
    ).toEqual([{ id: "createdAt", operator: "gte", value: "2026-01-01" }]);
  });

  it("never writes the variant or the row name back to the URL", () => {
    const [filter] = toUrlFilters<Organization>(
      [
        {
          id: "name",
          value: "feeds",
          variant: "text",
          operator: "iLike",
          filterId: "abc123",
        },
      ],
      columnVariants,
    );

    expect(filter && Object.keys(filter).sort()).toEqual(["id", "value"]);
  });
});
