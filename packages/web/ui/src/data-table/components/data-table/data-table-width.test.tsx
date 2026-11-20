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
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Button } from "../../../elements/index.js";

import { useDataTable } from "../../hooks/use-data-table.js";
import { columnVisibilityStorageKey } from "../../lib/column-visibility-storage.js";
import { DataTable } from "./data-table.js";
import { DataTableSkeleton } from "./data-table-skeleton.js";
import { DataTableToolbar } from "./data-table-toolbar.js";

import {
  type Load,
  LOADS,
  COLUMNS,
  TABLE_ID,
  stubViewport,
  LoadsTable,
  UnlinkedLoadsTable,
  detailLabels,
  openColumnsMenu,
  headerNames,
  setUpWidthTests,
  tearDownWidthTests,
  UNLINKED_COLUMNS,
  TypedLoadsTable,
} from "./test-support/data-table-width-test-fixture.js";

beforeEach(setUpWidthTests);
afterEach(tearDownWidthTests);

describe("DataTable on wide screens", () => {
  it("keeps every column and pins the identifying and actions columns", () => {
    render(<LoadsTable />);

    expect(headerNames()).toEqual([
      "Ticket",
      "Status",
      "Customer",
      "Product",
      "Carrier",
      "Loaded",
      "",
    ]);

    const [ticketHeader] = screen.getAllByRole("columnheader");
    const ticketCell = screen.getByRole("cell", { name: "T-1001" });
    for (const pinned of [ticketHeader, ticketCell]) {
      expect(pinned?.style.position).toBe("sticky");
      expect(pinned?.style.left).toBe("0px");
      expect(pinned?.getAttribute("data-pinned")).toBe("left");
      expect(pinned?.style.background).toBe("");
      expect(pinned?.style.opacity).toBe("");
    }
    expect(ticketHeader?.className).toContain("data-[pinned]:bg-table-header");
    expect(ticketCell.className).toContain("data-[pinned]:bg-card");

    const actionsCell = screen
      .getByRole("button", { name: "Void Ticket" })
      .closest("td");
    expect(actionsCell?.getAttribute("data-pinned")).toBe("right");
    expect(actionsCell?.style.right).toBe("0px");

    const carrierCell = screen.getByRole("cell", { name: "Prairie Freight" });
    expect(carrierCell.style.position).toBe("");
    expect(carrierCell.hasAttribute("data-pinned")).toBe(false);
  });
});

describe("DataTable Columns menu", () => {
  it("offers only the columns a reader may hide", () => {
    render(<LoadsTable />);
    openColumnsMenu();

    const offered = screen
      .getAllByRole("menuitemcheckbox")
      .map((item) => item.textContent);
    expect(offered).toEqual([
      "Status",
      "Customer",
      "Product",
      "Carrier",
      "Loaded At",
    ]);
    for (const item of screen.getAllByRole("menuitemcheckbox")) {
      expect(item.getAttribute("aria-checked")).toBe("true");
    }
  });

  it("hides a chosen column, says so, and remembers it for the named table", () => {
    const { unmount } = render(<LoadsTable />);
    expect(screen.queryByText(/Hidden/)).toBeNull();

    openColumnsMenu();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Carrier" }));

    expect(headerNames()).not.toContain("Carrier");
    expect(screen.getByText("1 Column Hidden")).toBeDefined();
    expect(
      JSON.parse(
        window.localStorage.getItem(columnVisibilityStorageKey(TABLE_ID)) ??
          "{}",
      ),
    ).toEqual({ carrier: false });

    unmount();
    render(<LoadsTable />);
    expect(headerNames()).not.toContain("Carrier");
    expect(screen.getByText("1 Column Hidden")).toBeDefined();
  });

  it("brings every hidden column back from the note's Show All", () => {
    window.localStorage.setItem(
      columnVisibilityStorageKey(TABLE_ID),
      JSON.stringify({ carrier: false, loadedAt: false }),
    );
    render(<LoadsTable />);

    const note = screen.getByText("2 Columns Hidden").parentElement;
    const showAll = note?.querySelector("button");
    expect(showAll?.textContent).toBe("Show All");
    if (showAll) fireEvent.click(showAll);

    expect(headerNames()).toContain("Carrier");
    expect(headerNames()).toContain("Loaded");
    expect(screen.queryByText(/Hidden/)).toBeNull();
  });

  it("keeps an unnamed table's choice for this visit only", () => {
    function UnnamedTable() {
      const { table } = useDataTable({
        data: LOADS,
        columns: COLUMNS,
        pageCount: 1,
      });
      return (
        <DataTable table={table}>
          <DataTableToolbar table={table} />
        </DataTable>
      );
    }
    render(<UnnamedTable />);
    openColumnsMenu();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Carrier" }));

    expect(headerNames()).not.toContain("Carrier");
    expect(window.localStorage.length).toBe(0);
  });
});

describe("DataTable on phones", () => {
  beforeEach(() => {
    stubViewport({ phone: true });
  });

  it("renders each row as a card with heading, summary, and actions", () => {
    const { container } = render(<LoadsTable />);

    expect(container.querySelector("table")).toBeNull();
    const card = container.querySelector<HTMLElement>(
      '[data-slot="data-table-card"]',
    );
    expect(card).not.toBeNull();

    const heading = card?.querySelector(
      '[data-slot="data-table-card-heading"]',
    );
    expect(heading?.querySelector("a")?.getAttribute("href")).toBe(
      "/loads/load-1",
    );

    const summary = card?.querySelector(
      '[data-slot="data-table-card-summary"]',
    );
    expect(
      [...(summary?.querySelectorAll("dt") ?? [])].map((dt) => dt.textContent),
    ).toEqual(["Status", "Customer", "Product"]);

    expect(
      card?.querySelector('[data-slot="data-table-card-actions"]')?.textContent,
    ).toBe("Void Ticket");

    const hitArea = card?.querySelector(
      '[data-slot="data-table-row-hit-area"]',
    );
    expect(hitArea?.getAttribute("href")).toBe("/loads/load-1");
    expect(hitArea?.getAttribute("aria-hidden")).toBe("true");
  });

  it("marks a linked card with a chevron and offers no in-place details", () => {
    const { container } = render(<LoadsTable />);

    const card = container.querySelector('[data-slot="data-table-card"]');
    expect(
      card?.querySelector('[data-slot="data-table-card-chevron"]'),
    ).not.toBeNull();
    expect(card?.querySelector("[aria-expanded]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
    expect(screen.queryByText("Prairie Freight")).toBeNull();
  });

  it("opens the primary link when the card is tapped", () => {
    const { container } = render(<LoadsTable />);
    const primary = screen.getByRole("link", { name: "T-1001" });
    const onPrimaryClick = vi.fn((event: Event) => {
      event.preventDefault();
    });
    primary.addEventListener("click", onPrimaryClick);

    const hitArea = container.querySelector(
      '[data-slot="data-table-card"] [data-slot="data-table-row-hit-area"]',
    );
    if (hitArea) fireEvent.click(hitArea);

    expect(onPrimaryClick).toHaveBeenCalledTimes(1);
  });

  it("expands an unlinked card in place to every other field", () => {
    const { container } = render(<UnlinkedLoadsTable />);

    const toggle = screen.getByRole("button", { name: "Details" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Prairie Freight")).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(detailLabels(container)).toEqual(["Carrier", "Loaded At"]);
    expect(screen.getByText("Prairie Freight")).toBeDefined();
    expect(screen.getByText("Aug 19")).toBeDefined();

    fireEvent.click(toggle);
    expect(screen.queryByText("Prairie Freight")).toBeNull();
  });

  it("keeps the empty state and its filter escape on phones", () => {
    function EmptyPhoneTable() {
      const { table } = useDataTable({
        data: [],
        columns: COLUMNS,
        pageCount: 0,
      });
      return (
        <DataTable
          table={table}
          emptyMessage="No loads match these filters."
          onClearFilters={() => undefined}
        />
      );
    }
    render(<EmptyPhoneTable />);

    expect(screen.getByText("No loads match these filters.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Clear Filters" })).toBeDefined();
    expect(screen.getByText("Page 1 of 1")).toBeDefined();
  });

  it("draws the loading skeleton as cards", () => {
    const { container } = render(
      <DataTableSkeleton columnCount={6} rowCount={3} />,
    );

    expect(container.querySelector("table")).toBeNull();
    expect(
      container.querySelectorAll(
        '[data-slot="data-table-skeleton-cards"] > li',
      ),
    ).toHaveLength(3);
  });

  it("drops the Columns menu and hidden-columns note, and expands to reader-hidden fields", () => {
    window.localStorage.setItem(
      columnVisibilityStorageKey(TABLE_ID),
      JSON.stringify({ carrier: false }),
    );
    const { container } = render(<UnlinkedLoadsTable />);

    expect(screen.queryByRole("button", { name: "Columns" })).toBeNull();
    expect(screen.queryByText(/Hidden/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(detailLabels(container)).toEqual(["Carrier", "Loaded At"]);
    expect(screen.getByText("Prairie Freight")).toBeDefined();
  });

  it("keeps a page-hidden, non-hideable column off the card", () => {
    const columns: ColumnDef<Load>[] = UNLINKED_COLUMNS.map((column) =>
      column.id === "carrier" ? { ...column, enableHiding: false } : column,
    );
    function ModeTable() {
      const { table } = useDataTable({
        data: LOADS,
        columns,
        pageCount: 1,
        initialState: { columnVisibility: { carrier: false } },
      });
      return <DataTable table={table} />;
    }
    render(<ModeTable />);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));

    expect(screen.getByText("Aug 19")).toBeDefined();
    expect(screen.queryByText("Prairie Freight")).toBeNull();
  });

  it("keeps primary controls and search in view and moves secondary ones into the Filters sheet", () => {
    function FilteredLoadsTable() {
      const { table } = useDataTable({
        data: LOADS,
        columns: COLUMNS,
        pageCount: 1,
        tableId: TABLE_ID,
      });
      return (
        <DataTable table={table}>
          <DataTableToolbar
            table={table}
            leading={<Button type="button">Open Loads</Button>}
            phonePrimary={<Button type="button">Inbound</Button>}
            search={<input type="search" aria-label="Search Tickets" />}
            activeFilterCount={2}
            phoneFilters={<Button type="button">Yesterday</Button>}
          >
            <Button type="button">Pick Dates</Button>
          </DataTableToolbar>
        </DataTable>
      );
    }
    const { container } = render(<FilteredLoadsTable />);

    const strip = container.querySelector(
      '[data-slot="data-table-toolbar-primary"]',
    );
    expect(
      [...(strip?.querySelectorAll("button") ?? [])].map(
        (button) => button.textContent,
      ),
    ).toEqual(["Inbound", "Open Loads"]);
    expect(
      screen.getByRole("searchbox", { name: "Search Tickets" }),
    ).toBeDefined();
    for (const name of ["Yesterday", "Pick Dates", "Columns"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }

    const trigger = screen.getByRole("button", { name: "Filters, 2 Applied" });
    expect(trigger.textContent).toBe("Filters2");
    fireEvent.click(trigger);

    const sheet = screen.getByRole("dialog", { name: "Filters" });
    for (const name of ["Yesterday", "Pick Dates", "Show Results"]) {
      expect(within(sheet).getByRole("button", { name })).toBeDefined();
    }
    for (const name of ["Open Loads", "Inbound"]) {
      expect(within(sheet).queryByRole("button", { name })).toBeNull();
    }
    expect(within(sheet).queryByRole("searchbox")).toBeNull();

    fireEvent.click(
      within(sheet).getByRole("button", { name: "Show Results" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lays filter groups flat in the sheet, applies them, and shows their chips", () => {
    render(<TypedLoadsTable resultCount={3} />);

    const trigger = screen.getByRole("button", { name: "Filters" });
    expect(screen.queryByRole("button", { name: /^Type/ })).toBeNull();
    fireEvent.click(trigger);

    const sheet = screen.getByRole("dialog", { name: "Filters" });
    const types = within(sheet).getByRole("group", { name: "Type" });
    fireEvent.click(within(types).getByRole("button", { name: "Transfers" }));
    fireEvent.click(within(types).getByRole("button", { name: "Sales" }));
    expect(
      within(types)
        .getByRole("button", { name: "Sales" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(
      within(sheet).getByRole("button", { name: "Show 3 Results" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Filters, 2 Applied" }),
    ).toBeDefined();
    const chips = screen.getByRole("group", { name: "Applied Filters" });
    expect(
      within(chips).getByRole("button", { name: "Remove Type: Sales" }),
    ).toBeDefined();
    expect(
      within(chips).getByRole("button", { name: "Remove Type: Transfers" }),
    ).toBeDefined();
  });

  it("puts every child behind the Filters button when the caller marks no search", () => {
    function PlainLoadsTable() {
      const { table } = useDataTable({
        data: LOADS,
        columns: COLUMNS,
        pageCount: 1,
      });
      return (
        <DataTable table={table}>
          <DataTableToolbar table={table}>
            <input type="search" aria-label="Search Tickets" />
          </DataTableToolbar>
        </DataTable>
      );
    }
    render(<PlainLoadsTable />);

    expect(screen.queryByRole("searchbox")).toBeNull();
    const trigger = screen.getByRole("button", { name: "Filters" });
    expect(trigger.textContent).toBe("Filters");
    fireEvent.click(trigger);
    expect(
      within(screen.getByRole("dialog", { name: "Filters" })).getByRole(
        "searchbox",
        { name: "Search Tickets" },
      ),
    ).toBeDefined();
  });
});
