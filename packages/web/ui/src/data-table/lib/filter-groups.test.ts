/**
 * What: the pure rules behind filter pills, phone toggle chips, and applied
 * chips — how one press changes a group's selection, and which values count
 * as applied.
 * Why: every list page shares these rules; a selection that reorders, keeps
 * an unknown value, or lets a single-select group hold two values would make
 * the pill, the chips, and the URL disagree.
 */
import { describe, expect, it } from "vitest";

import {
  countAppliedFilterValues,
  type FilterGroup,
  listAppliedFilterValues,
  removeFilterValue,
  selectedFilterLabels,
  toggleFilterValue,
} from "./filter-groups.js";

const OPTIONS = [
  { value: "SALE", label: "Sales" },
  { value: "PURCHASE", label: "Purchases" },
  { value: "TRANSFER", label: "Transfers" },
];

function group(overrides: Partial<FilterGroup> = {}): FilterGroup {
  return {
    id: "type",
    label: "Type",
    options: OPTIONS,
    selected: [],
    onSelectedChange: () => undefined,
    ...overrides,
  };
}

describe("toggleFilterValue", () => {
  it("adds and removes values of a multi-select group in option order", () => {
    expect(
      toggleFilterValue(group({ selected: ["TRANSFER"] }), "SALE"),
    ).toEqual(["SALE", "TRANSFER"]);
    expect(
      toggleFilterValue(group({ selected: ["SALE", "TRANSFER"] }), "SALE"),
    ).toEqual(["TRANSFER"]);
  });

  it("drops values no option knows", () => {
    expect(
      toggleFilterValue(group({ selected: ["GONE"] }), "PURCHASE"),
    ).toEqual(["PURCHASE"]);
  });

  it("switches a single-select group and clears it on a second press", () => {
    const single = group({ multiple: false, selected: ["SALE"] });
    expect(toggleFilterValue(single, "PURCHASE")).toEqual(["PURCHASE"]);
    expect(toggleFilterValue(single, "SALE")).toEqual([]);
  });
});

describe("applied values", () => {
  it("removes one value and names the rest in option order", () => {
    const set = group({ selected: ["TRANSFER", "SALE"] });
    expect(removeFilterValue(set, "TRANSFER")).toEqual(["SALE"]);
    expect(selectedFilterLabels(set)).toEqual(["Sales", "Transfers"]);
  });

  it("lists and counts every applied value across groups", () => {
    const groups = [
      group({ selected: ["SALE"] }),
      group({
        id: "direction",
        label: "Direction",
        options: [{ value: "IN", label: "Inbound" }],
        selected: ["IN"],
      }),
    ];
    expect(listAppliedFilterValues(groups)).toEqual([
      {
        groupId: "type",
        groupLabel: "Type",
        value: "SALE",
        valueLabel: "Sales",
      },
      {
        groupId: "direction",
        groupLabel: "Direction",
        value: "IN",
        valueLabel: "Inbound",
      },
    ]);
    expect(countAppliedFilterValues(groups)).toBe(2);
  });
});
