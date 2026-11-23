/**
 * What: an empty list is ZERO only when nothing exists in any view; an empty
 * tab or search among existing records keeps the table.
 * Why: counting a view tab as "something exists" made a company with no
 * records flip between the table and the empty page with every tab click.
 */
import { describe, expect, it } from "vitest";

import { keepTableWhileChecking, needsUnfilteredTotal, readListEmptiness } from "./list-emptiness.js";

describe("readListEmptiness", () => {
  it("has rows whenever the page returned any", () => {
    expect(
      readListEmptiness({
        total: 3,
        activeFilterCount: 2,
        unfilteredTotal: undefined,
        unfilteredFailed: false,
      }),
    ).toBe("HAS_ROWS");
  });

  it("reads an unnarrowed empty page as nothing being there yet", () => {
    expect(
      readListEmptiness({
        total: 0,
        activeFilterCount: 0,
        unfilteredTotal: undefined,
        unfilteredFailed: false,
      }),
    ).toBe("ZERO");
  });

  it("reads an empty tab as nothing there when no view has any record", () => {
    expect(
      readListEmptiness({
        total: 0,
        activeFilterCount: 1,
        unfilteredTotal: 0,
        unfilteredFailed: false,
      }),
    ).toBe("ZERO");
  });

  it("keeps the table for an empty tab or search when records exist elsewhere", () => {
    expect(
      readListEmptiness({
        total: 0,
        activeFilterCount: 1,
        unfilteredTotal: 4,
        unfilteredFailed: false,
      }),
    ).toBe("NO_MATCHES");
  });

  it("holds a narrowed empty page until the unnarrowed count answers", () => {
    expect(
      readListEmptiness({
        total: 0,
        activeFilterCount: 1,
        unfilteredTotal: undefined,
        unfilteredFailed: false,
      }),
    ).toBe("CHECKING");
  });

  it("falls back to the table when the unnarrowed count fails, never a skeleton that cannot resolve", () => {
    expect(
      readListEmptiness({
        total: 0,
        activeFilterCount: 1,
        unfilteredTotal: undefined,
        unfilteredFailed: true,
      }),
    ).toBe("NO_MATCHES");
  });
});

describe("needsUnfilteredTotal", () => {
  it("asks only when a narrowed view came back empty", () => {
    expect(needsUnfilteredTotal({ total: 0, activeFilterCount: 1 })).toBe(true);
    expect(needsUnfilteredTotal({ total: 0, activeFilterCount: 0 })).toBe(false);
    expect(needsUnfilteredTotal({ total: 2, activeFilterCount: 1 })).toBe(false);
    expect(needsUnfilteredTotal({ total: undefined, activeFilterCount: 1 })).toBe(false);
  });
});

describe("keepTableWhileChecking", () => {
  it("holds a first look on the skeleton until the probe answers", () => {
    expect(keepTableWhileChecking("CHECKING", false)).toBe("CHECKING");
  });

  it("keeps a table already on screen, so a search that empties it does not unmount the search box", () => {
    expect(keepTableWhileChecking("CHECKING", true)).toBe("NO_MATCHES");
  });

  it("leaves every settled answer alone", () => {
    expect(keepTableWhileChecking("ZERO", true)).toBe("ZERO");
    expect(keepTableWhileChecking("HAS_ROWS", false)).toBe("HAS_ROWS");
    expect(keepTableWhileChecking(undefined, true)).toBeUndefined();
  });
});
