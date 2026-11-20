// A rail flattens server pages, keeps two pages loaded past the last visible row, and toggles the Name sort.
import { describe, expect, it } from "vitest";

import {
  flattenRailPages,
  isRailPartiallyLoaded,
  isRailStatusChange,
  railRecordKey,
  railSortDirection,
  shouldLoadMoreRailRows,
  toggledNameSort,
} from "./rail-list.js";

describe("flattenRailPages", () => {
  it("returns no rows before the first page arrives", () => {
    expect(flattenRailPages(undefined)).toEqual({ items: [], total: 0 });
    expect(flattenRailPages({ pages: [] })).toEqual({ items: [], total: 0 });
  });

  it("keeps server order and reads the total from the newest page", () => {
    expect(
      flattenRailPages({
        pages: [
          { items: ["a", "b"], meta: { total: 5 } },
          { items: ["c", "d"], meta: { total: 6 } },
        ],
      }),
    ).toEqual({ items: ["a", "b", "c", "d"], total: 6 });
  });
});

describe("shouldLoadMoreRailRows", () => {
  const base = {
    loadedCount: 150,
    pageSize: 50,
    hasNextPage: true,
    isFetchingNextPage: false,
  };

  it("waits while more than two pages remain past the last visible row", () => {
    expect(shouldLoadMoreRailRows({ ...base, lastVisibleIndex: 20 })).toBe(
      false,
    );
    expect(shouldLoadMoreRailRows({ ...base, lastVisibleIndex: 49 })).toBe(
      false,
    );
  });

  it("asks once fewer than two pages remain past the last visible row", () => {
    expect(shouldLoadMoreRailRows({ ...base, lastVisibleIndex: 50 })).toBe(
      true,
    );
    expect(shouldLoadMoreRailRows({ ...base, lastVisibleIndex: 149 })).toBe(
      true,
    );
  });

  it("fills two pages ahead straight after the first page loads", () => {
    expect(
      shouldLoadMoreRailRows({
        ...base,
        loadedCount: 50,
        lastVisibleIndex: 12,
      }),
    ).toBe(true);
  });

  it("never asks when the list is complete, a page is in flight, or nothing is drawn", () => {
    expect(
      shouldLoadMoreRailRows({
        ...base,
        hasNextPage: false,
        lastVisibleIndex: 149,
      }),
    ).toBe(false);
    expect(
      shouldLoadMoreRailRows({
        ...base,
        isFetchingNextPage: true,
        lastVisibleIndex: 149,
      }),
    ).toBe(false);
    expect(shouldLoadMoreRailRows({ ...base, lastVisibleIndex: -1 })).toBe(
      false,
    );
  });

  it("honors a custom look-ahead", () => {
    expect(
      shouldLoadMoreRailRows({
        ...base,
        lastVisibleIndex: 100,
        pagesAhead: 1,
      }),
    ).toBe(true);
    expect(
      shouldLoadMoreRailRows({
        ...base,
        lastVisibleIndex: 98,
        pagesAhead: 1,
      }),
    ).toBe(false);
  });
});

describe("isRailPartiallyLoaded", () => {
  it("is true only while rows remain unloaded", () => {
    expect(isRailPartiallyLoaded(50, 120)).toBe(true);
    expect(isRailPartiallyLoaded(120, 120)).toBe(false);
    expect(isRailPartiallyLoaded(0, 0)).toBe(false);
  });
});

describe("rail sort", () => {
  it("reads the direction for one key", () => {
    expect(railSortDirection("name", "name")).toBe("asc");
    expect(railSortDirection("-name", "name")).toBe("desc");
    expect(railSortDirection("createdAt", "name")).toBeNull();
  });

  it("toggles ascending to descending and back, starting ascending from another key", () => {
    expect(toggledNameSort("name")).toBe("-name");
    expect(toggledNameSort("-name")).toBe("name");
    expect(toggledNameSort("-createdAt")).toBe("name");
  });
});

describe("isRailStatusChange", () => {
  it("is true only when the status differs, since a status lists different records", () => {
    expect(
      isRailStatusChange({ status: "active" }, { status: "archived" }),
    ).toBe(true);
    expect(isRailStatusChange({ status: "archived" }, { status: "all" })).toBe(
      true,
    );
  });

  it("is false for search, sort, filter and page changes that keep the status", () => {
    const before = { status: "active", sort: "name" };
    const after = { status: "active", sort: "-name" };
    expect(isRailStatusChange(before, after)).toBe(false);
  });
});

describe("railRecordKey", () => {
  const record = { slug: "pump-1", facilitySlug: "north-plant" };

  it("includes the facility company-wide, since slugs are only unique per facility", () => {
    expect(railRecordKey(record, true)).toBe("north-plant/pump-1");
  });

  it("is the slug alone when the rail lists one facility", () => {
    expect(railRecordKey(record, false)).toBe("pump-1");
  });
});
