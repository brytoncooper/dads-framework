/**
 * What: the table parts that sit straight on the page background — the
 * filter pills and applied chips in the toolbar, the hidden-columns note, and
 * the pagination row — use the full foreground, never `text-muted-foreground`
 * and never a faded `text-foreground/NN`.
 * Why: grey text on the grey page is hard to read. Muted text belongs on the
 * white table and in popovers, where it still clears 4.5:1. The page
 * primitives in `@dads-framework/ui/page` hold the same rule.
 * @vitest-environment jsdom
 */
import { cleanup, render } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it } from "vitest";

import { useDataTable } from "../../hooks/use-data-table.js";
import { defaultDataTableState } from "../../lib/data-table-search-params.js";
import { AppliedFilterChips } from "./applied-filter-chips.js";
import { DataTableHiddenColumnsNote } from "./data-table-hidden-columns-note.js";
import { DataTablePagination } from "./data-table-pagination.js";
import { FilterGroupToggles } from "./filter-group-toggles.js";
import { FilterPill } from "./filter-pill.js";

afterEach(cleanup);

/**
 * Class names that make text grey: muted ink, or the foreground faded. An
 * icon variant (`[&_svg…]:`) is not text, and a control's
 * `data-[placeholder]:` ink shows only while it holds no value.
 */
function isGreyTextClass(className: string): boolean {
  const cut = className.lastIndexOf(":");
  const variants = className.slice(0, Math.max(cut, 0));
  const utility = className.slice(cut + 1);
  if (variants.includes("_svg") || variants.includes("data-[placeholder]")) {
    return false;
  }
  return utility === "text-muted-foreground" || /^text-foreground\/\d+$/.test(utility);
}

function greyTextClasses(container: HTMLElement): string[] {
  const found: string[] = [];
  for (const element of [container, ...container.querySelectorAll("*")]) {
    for (const className of element.classList) {
      if (isGreyTextClass(className)) {
        found.push(`<${element.tagName.toLowerCase()}> ${className}`);
      }
    }
  }
  return found;
}

const ignore = () => undefined;

const TYPE_OPTIONS = [
  { value: "SALE", label: "Sales" },
  { value: "TRANSFER", label: "Transfers" },
];

function TableFooter({ part }: { readonly part: "pagination" | "hidden" }) {
  const { table } = useDataTable({
    data: [{ id: "recipe", note: "Mix" }],
    columns: [{ accessorKey: "id" }, { accessorKey: "note" }],
    pageCount: 3,
    state: defaultDataTableState,
    onStateChange: ignore,
    initialState: { columnVisibility: { note: false } },
  });
  return part === "pagination" ? (
    <DataTablePagination table={table} withSelectionStatus />
  ) : (
    <DataTableHiddenColumnsNote table={table} />
  );
}

const PAGE_BACKGROUND_PARTS: readonly (readonly [string, () => React.ReactElement])[] = [
  [
    "FilterPill, unset",
    () => <FilterPill label="Type" options={TYPE_OPTIONS} selected={[]} onSelectedChange={ignore} />,
  ],
  [
    "AppliedFilterChips",
    () => (
      <AppliedFilterChips
        groups={[
          {
            id: "type",
            label: "Type",
            options: TYPE_OPTIONS,
            selected: ["SALE"],
            onSelectedChange: ignore,
          },
        ]}
      />
    ),
  ],
  [
    "FilterGroupToggles, in the phone Filters sheet",
    () => (
      <FilterGroupToggles
        group={{
          id: "type",
          label: "Type",
          options: TYPE_OPTIONS,
          selected: ["SALE"],
          onSelectedChange: ignore,
        }}
      />
    ),
  ],
  ["DataTablePagination", () => <TableFooter part="pagination" />],
  ["DataTableHiddenColumnsNote", () => <TableFooter part="hidden" />],
];

describe("table text on the page background", () => {
  it.each(PAGE_BACKGROUND_PARTS)("%s never sets grey text on the grey page", (_name, renderPart) => {
    const { container } = render(renderPart());
    expect(container.textContent).not.toBe("");
    expect(greyTextClasses(container)).toEqual([]);
  });
});
