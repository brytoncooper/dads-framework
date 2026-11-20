import { describe, expect, it } from "vitest";

import {
  compactDataTableSearchParams,
  dataTableSearchSchema,
  type DataTableState,
  defaultDataTableState,
  toDataTableSearchParams,
} from "./data-table-search-params.js";

const nameFilter = { id: "name", value: "feeds" };

/**
 * What TanStack Router's `stringifySearch` would write for a search object:
 * `undefined` values never reach the query string, and non-primitives are
 * JSON. A bare URL is therefore an empty string here.
 */
function toQueryString(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined) continue;
    params.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function stateWith(overrides: Partial<DataTableState>): DataTableState {
  return { ...defaultDataTableState, ...overrides };
}

describe("dataTableSearchSchema", () => {
  it("fills the default view in from an empty URL", () => {
    expect(dataTableSearchSchema.parse({})).toEqual(defaultDataTableState);
  });

  it("reads the compact sort param", () => {
    expect(dataTableSearchSchema.parse({ sort: "name.desc" })).toEqual(
      stateWith({ sort: [{ id: "name", desc: true }] }),
    );
  });

  it("still reads the JSON sort array older links carry", () => {
    expect(
      dataTableSearchSchema.parse({
        page: 1,
        perPage: 25,
        sort: [{ id: "name", desc: true }],
        filters: [],
        joinOperator: "and",
      }),
    ).toEqual(stateWith({ sort: [{ id: "name", desc: true }] }));
  });

  it("reads the compact filters param", () => {
    expect(
      dataTableSearchSchema.parse({ filters: "status.ACTIVE*name.feeds" }),
    ).toEqual(
      stateWith({
        filters: [
          { id: "status", value: "ACTIVE" },
          { id: "name", value: "feeds" },
        ],
      }),
    );
  });

  it("still reads the JSON filters array older links carry", () => {
    expect(
      dataTableSearchSchema.parse({
        filters: [
          {
            id: "status",
            value: ["ARCHIVED"],
            variant: "select",
            operator: "eq",
            filterId: "abc123",
          },
        ],
      }),
    ).toEqual(
      stateWith({
        filters: [
          {
            id: "status",
            value: ["ARCHIVED"],
            variant: "select",
            operator: "eq",
            filterId: "abc123",
          },
        ],
      }),
    );
  });

  it("rewrites a legacy JSON filter to the compact spelling on the way out", () => {
    const legacy = dataTableSearchSchema.parse({
      filters: [
        {
          id: "status",
          value: ["ARCHIVED"],
          variant: "select",
          operator: "eq",
          filterId: "abc123",
        },
      ],
    });

    expect(toDataTableSearchParams(legacy).filters).toBe("status.eq.ARCHIVED");
  });

  it("coerces the numbers a query string hands back as text", () => {
    expect(dataTableSearchSchema.parse({ page: "3", perPage: "25" })).toEqual(
      stateWith({ page: 3, perPage: 25 }),
    );
  });

  it("degrades a mangled param to its default instead of throwing", () => {
    expect(
      dataTableSearchSchema.parse({
        page: "nonsense",
        sort: 42,
        filters: "nope",
        joinOperator: "xor",
      }),
    ).toEqual(defaultDataTableState);
  });
});

describe("toDataTableSearchParams", () => {
  it("writes nothing at all for the default view", () => {
    expect(toQueryString(toDataTableSearchParams(defaultDataTableState))).toBe(
      "",
    );
  });

  it("writes only the params that deviate", () => {
    const search = toDataTableSearchParams(
      stateWith({ page: 2, sort: [{ id: "name", desc: true }] }),
    );

    expect(toQueryString(search)).toBe("?page=2&sort=name.desc");
  });

  it("writes a non-default page size and join operator", () => {
    const search = toDataTableSearchParams(
      stateWith({ perPage: 50, joinOperator: "or" }),
    );

    expect(toQueryString(search)).toBe("?perPage=50&joinOperator=or");
  });

  it("writes filters compactly, and only once there are any", () => {
    const unfiltered = toDataTableSearchParams(defaultDataTableState);
    const filtered = toDataTableSearchParams(
      stateWith({
        filters: [nameFilter, { id: "status", value: ["ACTIVE", "ARCHIVED"] }],
      }),
    );

    expect(unfiltered.filters).toBeUndefined();
    expect(toQueryString(filtered)).toBe(
      "?filters=name.feeds*status.ACTIVE%2CARCHIVED",
    );
  });

  it("round-trips back through the schema", () => {
    const state = stateWith({
      page: 4,
      perPage: 50,
      sort: [
        { id: "status", desc: true },
        { id: "createdAt", desc: false },
      ],
      filters: [nameFilter],
      joinOperator: "or",
    });

    expect(dataTableSearchSchema.parse(toDataTableSearchParams(state))).toEqual(
      state,
    );
  });
});

describe("compactDataTableSearchParams", () => {
  it("compacts whatever the rest of the middleware chain produced", () => {
    const validated = stateWith({ sort: [{ id: "name", desc: true }] });

    const compacted = compactDataTableSearchParams({
      search: validated,
      next: () => validated,
    });

    expect(toQueryString(compacted)).toBe("?sort=name.desc");
  });

  it("leaves a route's own search params alone", () => {
    const validated = { ...defaultDataTableState, view: "grid" };

    const compacted = compactDataTableSearchParams({
      search: validated,
      next: () => validated,
    });

    expect(toQueryString(compacted)).toBe("?view=grid");
  });
});
