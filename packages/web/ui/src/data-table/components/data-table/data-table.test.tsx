/**
 * What: the shared table exposes only real interactions, preserves readable
 * content while updating, and keeps its dense controls consistent.
 * Why: nested clear controls, implicit row selection, and mixed loading/live
 * geometry made every collection inherit the same accessibility and polish
 * defects.
 * @vitest-environment jsdom
 */
import {
  type ColumnDef,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { useDataTable } from "../../hooks/use-data-table.js";
import type { DataTableState } from "../../lib/data-table-search-params.js";
import { DataTable } from "./data-table.js";
import { DataTablePagination } from "./data-table-pagination.js";
import { DataTableToolbar } from "./data-table-toolbar.js";

import {
  type ExampleRow,
  ROWS,
  COLUMNS,
  FILTERED_STATE,
  UNFILTERED_STATE,
  ExampleTable,
  installResizeObserver,
} from "./test-support/data-table-test-fixture.js";

beforeAll(installResizeObserver);
afterEach(cleanup);

describe("DataTable interaction semantics", () => {
  it("scrolls only sideways, leaving vertical scrolling to the page", () => {
    const { container } = render(<ExampleTable />);

    const scroller = container.querySelector(
      '[data-slot="data-table-content"] [data-slot="table-container"]',
    );
    expect(scroller?.className).toContain("overflow-x-auto");
    expect(scroller?.className).not.toContain("max-h-");
    expect(scroller?.className).not.toContain("overscroll-contain");
  });

  it("keeps a required single-choice filter without clear or reset actions", () => {
    const requiredStatusColumns: ColumnDef<ExampleRow>[] = COLUMNS.map(
      (column) =>
        column.id === "status"
          ? {
              ...column,
              meta: {
                ...column.meta,
                canClearFilter: false,
                options: [
                  {
                    label: "Active",
                    value: "ACTIVE",
                    badgeTone: "information",
                  },
                  { label: "All", value: "ALL" },
                ],
              },
            }
          : { ...column, enableColumnFilter: false },
    );
    const requiredStatusState: DataTableState = {
      ...UNFILTERED_STATE,
      filters: [{ id: "status", value: ["ACTIVE"] }],
    };
    const { container } = render(
      <ExampleTable
        columns={requiredStatusColumns}
        initialState={requiredStatusState}
        rows={[]}
        withExtraAction={false}
        withToolbar
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Clear Status Filter" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset Filters" })).toBeNull();
    expect(screen.queryByText("Clear Filters")).toBeNull();
    expect(
      container.querySelector('[data-slot="status-badge"]')?.textContent,
    ).toBe("Active");

    fireEvent.click(screen.getByRole("button", { name: "Status Active" }));

    expect(screen.queryByText("Clear Filters")).toBeNull();
    const selectedIndicator = document.querySelector(
      '[data-slot="data-table-single-select-indicator"]',
    );
    expect(selectedIndicator).not.toBeNull();
    expect(selectedIndicator?.parentElement?.className).not.toContain(
      "[&>svg:last-child]:hidden",
    );
    expect(
      document.querySelector('[data-slot="data-table-multi-select-checkbox"]'),
    ).toBeNull();
  });

  it("offers Clear Filters for page-owned narrowing with no column filter set", () => {
    const onClearFilters = vi.fn();
    function PageFilteredTable() {
      const [state, setState] = React.useState(UNFILTERED_STATE);
      const { table } = useDataTable({
        data: [],
        columns: COLUMNS,
        pageCount: 0,
        state,
        onStateChange: setState,
      });
      return (
        <DataTable
          table={table}
          emptyMessage="No mills match these filters."
          onClearFilters={onClearFilters}
        />
      );
    }

    render(<PageFilteredTable />);

    expect(screen.getByText("No mills match these filters.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Clear Filters" }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it("clears column filters and page-owned narrowing together", () => {
    const onClearFilters = vi.fn();
    function BothFilteredTable() {
      const [state, setState] = React.useState(FILTERED_STATE);
      const { table } = useDataTable({
        data: [],
        columns: COLUMNS,
        pageCount: 0,
        state,
        onStateChange: setState,
      });
      return (
        <DataTable table={table} onClearFilters={onClearFilters}>
          <DataTableToolbar table={table} />
        </DataTable>
      );
    }

    render(<BothFilteredTable />);

    fireEvent.click(screen.getByRole("button", { name: "Clear Filters" }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Clear Status Filter" }),
    ).toBeNull();
  });

  it("renders every active filter clear action as a separate native button", () => {
    const { container } = render(
      <ExampleTable initialState={FILTERED_STATE} withToolbar />,
    );

    const clearStatus = screen.getByRole("button", {
      name: "Clear Status Filter",
    });
    const clearCreated = screen.getByRole("button", {
      name: "Clear Created Filter",
    });
    const clearAmount = screen.getByRole("button", {
      name: "Clear Amount Filter",
    });

    expect(clearStatus.tagName).toBe("BUTTON");
    expect(clearCreated.tagName).toBe("BUTTON");
    expect(clearAmount.tagName).toBe("BUTTON");
    expect(container.querySelector("button button")).toBeNull();

    clearStatus.focus();
    fireEvent.click(clearStatus);
    expect(
      screen.queryByRole("button", { name: "Clear Status Filter" }),
    ).toBeNull();
  });

  it("announces an update without dimming or replacing table content", () => {
    const { container } = render(<ExampleTable isUpdating />);

    const table = screen.getByTestId("example-table");
    const busyContent = container.querySelector<HTMLElement>(
      '[data-slot="data-table-content"]',
    );
    const status = screen.getByRole("status");
    expect(busyContent?.getAttribute("aria-busy")).toBe("true");
    expect(busyContent?.contains(status)).toBe(false);
    expect(status.textContent).toContain("Updating Table");
    expect(
      status.querySelector<HTMLElement>('[aria-hidden="true"]')?.className,
    ).toContain("motion-reduce:animate-none");
    expect(screen.getByText("North Mill")).toBeDefined();
    expect(table.className).not.toContain("opacity");
  });

  it("keeps each row's extra hit area on that row, not the last row", () => {
    const columns: ColumnDef<ExampleRow>[] = [
      {
        id: "name",
        cell: ({ row }) => (
          <a href={`/mills/${row.original.name}`}>{row.original.name}</a>
        ),
      },
      { id: "status", accessorKey: "status" },
    ];
    const rows: ExampleRow[] = [
      {
        name: "North Mill",
        status: "ACTIVE",
        createdAt: "2026-08-19T12:00:00.000Z",
        amount: 12,
      },
      {
        name: "South Mill",
        status: "ACTIVE",
        createdAt: "2026-08-19T12:00:00.000Z",
        amount: 8,
      },
    ];
    const { container } = render(
      <ExampleTable columns={columns} rows={rows} />,
    );
    const bodyRows = [
      ...container.querySelectorAll(
        '[data-slot="table-body"] [data-slot="table-row"]',
      ),
    ];

    expect(bodyRows).toHaveLength(2);
    for (const bodyRow of bodyRows) {
      expect(bodyRow.className.split(/\s+/)).not.toContain("relative");
    }

    const northHits = bodyRows[0]?.querySelectorAll(
      '[data-slot="data-table-row-hit-area"]',
    );
    const southHits = bodyRows[1]?.querySelectorAll(
      '[data-slot="data-table-row-hit-area"]',
    );
    expect(northHits).toHaveLength(1);
    expect(southHits).toHaveLength(1);
    expect(northHits?.[0]?.getAttribute("href")).toBe("/mills/North Mill");
    expect(southHits?.[0]?.getAttribute("href")).toBe("/mills/South Mill");
    expect(northHits?.[0]?.closest('[data-slot="table-row"]')).toBe(
      bodyRows[0],
    );
    expect(southHits?.[0]?.closest('[data-slot="table-row"]')).toBe(
      bodyRows[1],
    );
  });

  it("heads each run of rows that share a group key with one group row", () => {
    const mill = (name: string, status: string): ExampleRow => ({
      name,
      status,
      createdAt: "2026-08-19T12:00:00.000Z",
      amount: 1,
    });
    const { container } = render(
      <ExampleTable
        rows={[
          mill("North Mill", "ACTIVE"),
          mill("South Mill", "ACTIVE"),
          mill("West Mill", "CLOSED"),
        ]}
        rowGroupOf={(row) => ({
          key: row.status,
          label: `Group ${row.status}`,
        })}
      />,
    );
    const groupRows = [
      ...container.querySelectorAll('[data-slot="data-table-group-row"]'),
    ];

    expect(groupRows.map((row) => row.textContent)).toEqual([
      "Group ACTIVE",
      "Group CLOSED",
    ]);
    expect(groupRows[0]?.querySelector("td")?.getAttribute("colspan")).toBe(
      "4",
    );
    expect(groupRows[1]?.nextElementSibling?.textContent).toContain(
      "West Mill",
    );
  });

  it("hides selection status until a caller opts into row selection", () => {
    const { rerender } = render(<ExampleTable />);

    expect(screen.queryByText(/row\(s\) selected/)).toBeNull();

    rerender(<ExampleTable enableRowSelection />);
    expect(screen.getByText("0 of 1 rows selected.")).toBeDefined();
  });

  it("treats an omitted external selection option as disabled", () => {
    function ExternalTablePagination() {
      const table = useReactTable({
        data: ROWS,
        columns: COLUMNS,
        getCoreRowModel: getCoreRowModel(),
      });
      return <DataTablePagination table={table} />;
    }

    render(<ExternalTablePagination />);

    expect(screen.queryByText(/row\(s\) selected/)).toBeNull();
  });
});
