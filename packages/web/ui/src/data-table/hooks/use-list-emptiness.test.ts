/**
 * What: a list page that has shown its table keeps it while a narrowed zero
 * is checked; a page that has not still waits on its skeleton.
 * Why: swapping the table for a skeleton mid-search unmounted the search box,
 * so the keys typed while it was gone were lost.
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useListEmptiness } from "./use-list-emptiness.js";

type Counts = Parameters<typeof useListEmptiness>[0];
const SCOPE = ["org-1"];

const ROWS: Counts = {
  total: 4,
  activeFilterCount: 0,
  unfilteredTotal: undefined,
  unfilteredFailed: false,
};
const NARROWED_TO_NOTHING: Counts = {
  total: 0,
  activeFilterCount: 1,
  unfilteredTotal: undefined,
  unfilteredFailed: false,
};
const NOTHING_AT_ALL: Counts = {
  total: 0,
  activeFilterCount: 0,
  unfilteredTotal: undefined,
  unfilteredFailed: false,
};

describe("useListEmptiness", () => {
  it("answers nothing while the list is pending", () => {
    const { result } = renderHook(() => useListEmptiness(undefined, SCOPE));
    expect(result.current).toBeUndefined();
  });

  it("checks on a first look at a narrowed zero", () => {
    const { result } = renderHook(() =>
      useListEmptiness(NARROWED_TO_NOTHING, SCOPE),
    );
    expect(result.current).toBe("CHECKING");
  });

  it("keeps the table once it has shown rows", () => {
    const { result, rerender } = renderHook(
      (counts: Counts) => useListEmptiness(counts, SCOPE),
      { initialProps: ROWS },
    );
    expect(result.current).toBe("HAS_ROWS");

    rerender(NARROWED_TO_NOTHING);
    expect(result.current).toBe("NO_MATCHES");
  });

  it("checks again after the page has shown its empty state", () => {
    const { result, rerender } = renderHook(
      (counts: Counts) => useListEmptiness(counts, SCOPE),
      { initialProps: ROWS },
    );
    rerender(NOTHING_AT_ALL);
    expect(result.current).toBe("ZERO");

    rerender(NARROWED_TO_NOTHING);
    expect(result.current).toBe("CHECKING");
  });
  it("checks again after the page moves to another scope", () => {
    const { result, rerender } = renderHook(
      ({ counts, scope }: { counts: Counts; scope: readonly string[] }) =>
        useListEmptiness(counts, scope),
      { initialProps: { counts: ROWS, scope: ["org-1"] } },
    );
    expect(result.current).toBe("HAS_ROWS");

    rerender({ counts: NARROWED_TO_NOTHING, scope: ["org-2"] });
    expect(result.current).toBe("CHECKING");
  });

  it("keeps the table when the same scope arrives as a new value", () => {
    const { result, rerender } = renderHook(
      ({ counts, scope }: { counts: Counts; scope: readonly string[] }) =>
        useListEmptiness(counts, scope),
      { initialProps: { counts: ROWS, scope: ["org-1"] } },
    );
    rerender({ counts: NARROWED_TO_NOTHING, scope: ["org-1"] });
    expect(result.current).toBe("NO_MATCHES");
  });
});
