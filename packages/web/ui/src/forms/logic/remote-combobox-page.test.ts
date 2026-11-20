/**
 * What: a fetched picker replaces page 1 on a new search and appends later
 * pages without duplicating rows.
 * Why: client-filtering the first page hides anything the server has not
 * sent yet; merge rules have to match that, not a local `.includes`.
 */
import { describe, expect, it } from "vitest";
import {
  nextRemoteComboboxItems,
  pageHasMore,
  shouldPrefetchNextPage,
} from "./remote-combobox-page.js";

const key = (item: { readonly value: string }): string => item.value;

describe("pageHasMore", () => {
  it("is true while unread rows remain after this page", () => {
    expect(pageHasMore({ page: 1, perPage: 50, total: 51 })).toBe(true);
    expect(pageHasMore({ page: 2, perPage: 50, total: 100 })).toBe(false);
    expect(pageHasMore({ page: 1, perPage: 50, total: 0 })).toBe(false);
  });
});

describe("nextRemoteComboboxItems", () => {
  it("replaces the list when the server answers page 1", () => {
    expect(
      nextRemoteComboboxItems({
        current: [{ value: "old" }],
        incoming: [{ value: "soy" }],
        page: 1,
        itemKey: key,
      }),
    ).toEqual([{ value: "soy" }]);
  });

  it("appends a later page and drops rows already held", () => {
    expect(
      nextRemoteComboboxItems({
        current: [{ value: "a" }, { value: "b" }],
        incoming: [{ value: "b" }, { value: "c" }],
        page: 2,
        itemKey: key,
      }),
    ).toEqual([{ value: "a" }, { value: "b" }, { value: "c" }]);
  });
});

describe("shouldPrefetchNextPage", () => {
  it("asks for the next page only when more exist and none is in flight", () => {
    expect(shouldPrefetchNextPage({ hasMore: true, loading: false })).toBe(
      true,
    );
    expect(shouldPrefetchNextPage({ hasMore: true, loading: true })).toBe(
      false,
    );
    expect(shouldPrefetchNextPage({ hasMore: false, loading: false })).toBe(
      false,
    );
  });
});
