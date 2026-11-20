/**
 * What: one removable chip per applied filter value, plus Clear All, and
 * nothing at all while no value is applied.
 * Why: the chips are how a reader sees and undoes every narrowing at a
 * glance; a chip that removed the wrong value or a Clear All that left one
 * behind would leave the list silently filtered.
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FilterGroup } from "../../lib/filter-groups.js";
import { AppliedFilterChips } from "./applied-filter-chips.js";

afterEach(cleanup);

function OrderChips({ onClearAll }: { readonly onClearAll?: () => void }) {
  const [types, setTypes] = React.useState<readonly string[]>([
    "SALE",
    "TRANSFER",
  ]);
  const [directions, setDirections] = React.useState<readonly string[]>(["IN"]);
  const groups: FilterGroup[] = [
    {
      id: "type",
      label: "Type",
      options: [
        { value: "SALE", label: "Sales" },
        { value: "TRANSFER", label: "Transfers" },
      ],
      selected: types,
      onSelectedChange: setTypes,
    },
    {
      id: "direction",
      label: "Direction",
      options: [{ value: "IN", label: "Inbound" }],
      selected: directions,
      onSelectedChange: setDirections,
    },
  ];
  return (
    <AppliedFilterChips
      groups={groups}
      {...(onClearAll === undefined ? {} : { onClearAll })}
    />
  );
}

function chipTexts(): (string | null)[] {
  return [
    ...document.querySelectorAll('[data-slot="applied-filter-chip"]'),
  ].map((chip) => chip.textContent);
}

describe("AppliedFilterChips", () => {
  it("shows one chip per applied value inside a named group", () => {
    render(<OrderChips />);

    expect(
      screen.getByRole("group", { name: "Applied Filters" }),
    ).toBeDefined();
    expect(chipTexts()).toEqual([
      "Type: Sales",
      "Type: Transfers",
      "Direction: Inbound",
    ]);
  });

  it("removes only the chip's own value", () => {
    render(<OrderChips />);

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Type: Transfers" }),
    );
    expect(chipTexts()).toEqual(["Type: Sales", "Direction: Inbound"]);
  });

  it("clears every group through its own change without a page-wide clear", () => {
    render(<OrderChips />);

    fireEvent.click(screen.getByRole("button", { name: "Clear All" }));
    expect(chipTexts()).toEqual([]);
    expect(screen.queryByRole("group", { name: "Applied Filters" })).toBeNull();
  });

  it("hands Clear All to the page when it clears in one write", () => {
    const onClearAll = vi.fn();
    render(<OrderChips onClearAll={onClearAll} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear All" }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
    expect(chipTexts()).toHaveLength(3);
  });
});
