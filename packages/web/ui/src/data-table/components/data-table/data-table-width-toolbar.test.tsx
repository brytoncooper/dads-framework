/**
 * What: no DataTable column is ever hidden by screen width. Wide screens pin
 * the identifying and actions columns and keep every other column; the reader
 * alone hides columns through the Columns menu, remembered per table and
 * announced with a Show All note; phones render every row as a card that opens
 * its record on tap, or, with no record link, expands in place to every field
 * (reader-hidden ones included), and a phone toolbar keeps the primary controls
 * and search in view beside one Filters button whose sheet holds the rest,
 * filter groups laid flat as toggle chips; applied values show as chips.
 * Why: these tables hold business records; a field that silently vanishes on
 * a smaller screen is data the operator never knew to look for.
 * @vitest-environment jsdom
 */
import type { ColumnDef } from "@tanstack/react-table";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Button } from "../../../elements/index.js";

import { useDataTable } from "../../hooks/use-data-table.js";
import { DataTable } from "./data-table.js";
import { DataTableToolbar } from "./data-table-toolbar.js";

import {
  type Load,
  LOADS,
  COLUMNS,
  stubViewport,
  headerNames,
  setUpWidthTests,
  tearDownWidthTests,
  TypedLoadsTable,
} from "./test-support/data-table-width-test-fixture.js";

beforeEach(setUpWidthTests);
afterEach(tearDownWidthTests);

describe("DataTable toolbar on wide screens", () => {
  it("leads the actions with the search and shows no Filters button", () => {
    function FilteredLoadsTable() {
      const { table } = useDataTable({
        data: LOADS,
        columns: COLUMNS,
        pageCount: 1,
      });
      return (
        <DataTable table={table}>
          <DataTableToolbar
            table={table}
            search={<input type="search" aria-label="Search Tickets" />}
            activeFilterCount={2}
            phoneFilters={<Button type="button">Inbound</Button>}
          >
            <Button type="button">Pick Dates</Button>
          </DataTableToolbar>
        </DataTable>
      );
    }
    const { container } = render(<FilteredLoadsTable />);

    const actions = container.querySelector(
      '[data-slot="data-table-toolbar-actions"]',
    );
    expect(
      [...(actions?.children ?? [])].map(
        (child) => child.getAttribute("aria-label") ?? child.textContent,
      ),
    ).toEqual(["Search Tickets", "Pick Dates"]);
    expect(screen.queryByRole("button", { name: /Filters/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Inbound" })).toBeNull();
    expect(screen.getByRole("button", { name: "Columns" })).toBeDefined();
  });

  it("puts the search, then a pill per filter group, then the caller's menus, then Columns", () => {
    const { container } = render(
      <TypedLoadsTable addFilter={<Button type="button">Add Filter</Button>} />,
    );

    const actions = container.querySelector(
      '[data-slot="data-table-toolbar-actions"]',
    );
    expect(
      [...(actions?.children ?? [])].map(
        (child) => child.getAttribute("aria-label") ?? child.textContent,
      ),
    ).toEqual(["Search Tickets", "Type", "Add Filter"]);
    expect(screen.getByRole("button", { name: "Columns" })).toBeDefined();
    expect(screen.queryByRole("group", { name: "Applied Filters" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Type" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Sales" }));
    expect(screen.getByRole("button", { name: "Type: Sales" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Clear All" }));
    expect(screen.getByRole("button", { name: "Type" })).toBeDefined();
  });
});

describe("DataTable pages that hide a column for a mode", () => {
  it("keeps a page-hidden, non-hideable column out of the reader's count", () => {
    const columns: ColumnDef<Load>[] = COLUMNS.map((column) =>
      column.id === "status" ? { ...column, enableHiding: false } : column,
    );
    function ModeTable() {
      const { table } = useDataTable({
        data: LOADS,
        columns,
        pageCount: 1,
        initialState: { columnVisibility: { status: false } },
      });
      return <DataTable table={table} />;
    }
    render(<ModeTable />);

    expect(headerNames()).not.toContain("Status");
    expect(screen.queryByText(/Hidden/)).toBeNull();
  });
});

describe("DataTable with a caller frame", () => {
  beforeEach(() => {
    stubViewport({ phone: false });
  });

  it("keeps the edge fade inside the caller's frame and shows it while columns lie past the right edge", () => {
    function FramedTable() {
      const { table } = useDataTable({
        data: LOADS,
        columns: COLUMNS,
        pageCount: 1,
      });
      return (
        <DataTable
          table={table}
          contentClassName="overflow-hidden rounded-xl border"
        />
      );
    }
    const { container } = render(<FramedTable />);
    const frame = container.querySelector<HTMLElement>(
      '[data-slot="data-table-content"]',
    );
    const scroller = container.querySelector<HTMLElement>(
      '[data-slot="table-container"]',
    );
    const rightFade = container.querySelector<HTMLElement>(
      '[data-slot="table-edge-fade"][data-edge="right"]',
    );
    if (!frame || !scroller || !rightFade)
      throw new Error("Expected a framed table.");

    expect(frame.className).toContain("rounded-xl");
    expect(frame.contains(rightFade)).toBe(true);

    for (const [name, value] of Object.entries({
      scrollLeft: 0,
      clientWidth: 400,
      scrollWidth: 900,
    })) {
      Object.defineProperty(scroller, name, { configurable: true, value });
    }
    fireEvent.scroll(scroller);

    expect(rightFade.hasAttribute("data-visible")).toBe(true);
  });
});
