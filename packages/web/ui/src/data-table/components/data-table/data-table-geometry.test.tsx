/**
 * What: the shared table exposes only real interactions, preserves readable
 * content while updating, and keeps its dense controls consistent.
 * Why: nested clear controls, implicit row selection, and mixed loading/live
 * geometry made every collection inherit the same accessibility and polish
 * defects.
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { Button } from "../../../elements/index.js";

import { useDataTable } from "../../hooks/use-data-table.js";
import { DataTableAdvancedToolbar } from "./data-table-advanced-toolbar.js";
import { DataTableColumnHeader } from "./data-table-column-header.js";
import { DataTablePagination } from "./data-table-pagination.js";
import { DataTableSkeleton } from "./data-table-skeleton.js";

import {
  ROWS,
  COLUMNS,
  FILTERED_STATE,
  ExampleTable,
  installResizeObserver,
} from "./test-support/data-table-test-fixture.js";

beforeAll(installResizeObserver);
afterEach(cleanup);

describe("DataTable compact responsive geometry", () => {
  it("stacks and wraps toolbar controls while keeping every control 32 pixels", () => {
    render(<ExampleTable initialState={FILTERED_STATE} withToolbar />);

    const toolbar = screen.getByRole("toolbar");
    expect(toolbar.className).toContain("flex-col");
    expect(toolbar.querySelector('[data-slot="data-table-toolbar-row"]')?.className).toContain("flex-wrap");
    expect(toolbar.className).toContain("[&_[data-slot=button]]:h-8");
    expect(toolbar.className).toContain("[&_[data-slot=button][data-variant=outline]]:border-input");

    const filterInput = screen.getByPlaceholderText("Search");
    expect(filterInput.getAttribute("data-size")).toBe("sm");
    expect(filterInput.className).toContain("h-8");

    const extraFilter = screen.getByRole("button", { name: "Extra Filter" });
    expect(extraFilter.className).toContain("[@media(pointer:coarse)]:min-h-11");
    expect(extraFilter.className).toContain("[@media(pointer:coarse)]:min-w-11");

    const popoverTriggers = Array.from(toolbar.querySelectorAll<HTMLElement>('[data-slot="popover-trigger"]'));
    expect(popoverTriggers).toHaveLength(3);
    for (const trigger of popoverTriggers) {
      expect(trigger.className).toContain("h-8");
      expect(trigger.className).toContain("border-input");
    }

    for (const name of ["Clear Status Filter", "Clear Created Filter", "Clear Amount Filter"]) {
      const clearButton = screen.getByRole("button", { name });
      expect(clearButton.className).toContain("size-8");
      expect(clearButton.className).toContain("border-input");
    }
  });

  it("uses live 32-pixel geometry in toolbar and pagination skeletons", () => {
    const { container } = render(
      <DataTableSkeleton actionWidths={["select"]} columnCount={4} filterWidths={["search", "narrow"]} rowCount={2} />,
    );

    const skeletons = Array.from(container.querySelectorAll<HTMLElement>('[data-slot="skeleton"]'));
    expect(skeletons.some((skeleton) => skeleton.className.includes("h-7"))).toBe(false);
    expect(skeletons.some((skeleton) => skeleton.className.includes("size-7"))).toBe(false);

    for (const slot of ["data-table-skeleton-toolbar", "data-table-skeleton-pagination"]) {
      const region = container.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
      expect(region?.className).toContain("[@media(pointer:coarse)]:[&_[data-slot=skeleton]]:min-h-11");
      expect(region?.className).toContain("[@media(pointer:coarse)]:[&_[data-slot=skeleton]]:min-w-11");
    }
  });

  it("models the widths and sides of the live toolbar controls", () => {
    const { container } = render(
      <DataTableSkeleton
        actionWidths={["wide", "medium"]}
        columnCount={4}
        filterWidths={["search", "narrow"]}
        rowCount={2}
      />,
    );

    const filterWidths = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="data-table-skeleton-filters"] [data-slot="skeleton"]'),
    ).map((skeleton) => skeleton.className);
    const actionWidths = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="data-table-skeleton-actions"] [data-slot="skeleton"]'),
    ).map((skeleton) => skeleton.className);

    expect(filterWidths).toEqual([expect.stringContaining("w-40"), expect.stringContaining("w-24")]);
    expect(actionWidths).toEqual([expect.stringContaining("w-44"), expect.stringContaining("w-32")]);
  });

  it("places trailing content in the columns region before the Columns menu", () => {
    render(<ExampleTable withToolbar trailing={<Button variant="outline">Trailing Pill</Button>} />);

    const columnsRegion = screen.getByRole("toolbar").querySelector('[data-slot="data-table-toolbar-columns"]');
    const trailingPill = screen.getByRole("button", { name: "Trailing Pill" });
    const columnsMenu = screen.getByRole("button", { name: "Columns" });

    expect(columnsRegion?.contains(trailingPill)).toBe(true);
    expect(columnsRegion?.contains(columnsMenu)).toBe(true);
    expect(trailingPill.compareDocumentPosition(columnsMenu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows a chip for a caller-rendered filter group without adding a pill for it", () => {
    const onSelectedChange = vi.fn();
    render(
      <ExampleTable
        withToolbar
        withExtraAction={false}
        chipGroups={[
          {
            id: "facility",
            label: "Facility",
            multiple: false,
            options: [{ value: "north", label: "North Plant" }],
            selected: ["north"],
            onSelectedChange,
          },
        ]}
      />,
    );

    expect(screen.getByText("Facility: North Plant")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Facility/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Remove .*Facility.*North Plant/ }));
    expect(onSelectedChange).toHaveBeenCalledWith([]);
  });

  it("omits the unused toolbar actions slot when there is no extra action", () => {
    const { container, rerender } = render(<ExampleTable withExtraAction={false} withToolbar />);

    expect(container.querySelector('[data-slot="data-table-toolbar-actions"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "View" })).toBeNull();

    function AdvancedToolbarExample() {
      return (
        <DataTableAdvancedToolbar>
          <Button variant="outline">Filter</Button>
        </DataTableAdvancedToolbar>
      );
    }

    rerender(<AdvancedToolbarExample />);
    expect(container.querySelector('[data-slot="data-table-toolbar-actions"]')).toBeNull();

    rerender(<DataTableSkeleton columnCount={4} filterWidths={["search"]} rowCount={2} />);
    expect(container.querySelector('[data-slot="data-table-skeleton-actions"]')).toBeNull();
  });

  it("cycles a sortable column through ascending, descending, and reset", () => {
    function SortableHeaderExample() {
      const { table } = useDataTable({
        data: ROWS,
        columns: COLUMNS,
        pageCount: 1,
      });
      const nameColumn = table.getColumn("name");
      if (nameColumn === undefined) {
        throw new Error("Expected the name column.");
      }
      if (nameColumn.getCanHide()) {
        throw new Error("Columns must stay visible.");
      }
      return (
        <>
          <DataTableColumnHeader column={nameColumn} label="Name" />
          <output aria-label="Sort State">{String(nameColumn.getIsSorted())}</output>
        </>
      );
    }

    render(<SortableHeaderExample />);

    const header = screen.getByRole("button", { name: "Name" });
    const sortState = screen.getByRole("status", { name: "Sort State" });

    expect(sortState.textContent).toBe("false");
    expect(header.className).not.toContain("text-primary");
    fireEvent.click(header);
    expect(sortState.textContent).toBe("asc");
    expect(header.className).toContain("text-primary");
    fireEvent.click(header);
    expect(sortState.textContent).toBe("desc");
    expect(header.className).toContain("text-primary");
    fireEvent.click(header);
    expect(sortState.textContent).toBe("false");
    expect(header.className).not.toContain("text-primary");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("omits empty toolbar geometry when the live table has no toolbar", () => {
    const { container } = render(<DataTableSkeleton columnCount={4} filterWidths={[]} rowCount={2} />);

    expect(container.querySelector('[data-slot="data-table-skeleton-toolbar"]')).toBeNull();
  });

  it("wraps pagination controls instead of relying on horizontal overflow", () => {
    function PaginationExample() {
      const { table } = useDataTable({
        data: ROWS,
        columns: COLUMNS,
        pageCount: 1,
      });
      return <DataTablePagination table={table} />;
    }

    const { container } = render(<PaginationExample />);
    const pagination = container.querySelector<HTMLElement>('[data-slot="data-table-pagination"]');

    expect(pagination).not.toBeNull();
    expect(pagination?.className).toContain("flex-wrap");
    expect(pagination?.className).not.toContain("overflow-auto");
    expect(pagination?.querySelector('[data-slot="select-trigger"]')?.getAttribute("data-size")).toBe("sm");
  });

  it("keeps an empty result set on a coherent first page", () => {
    function EmptyPaginationExample() {
      const { table } = useDataTable({
        data: [],
        columns: COLUMNS,
        pageCount: 0,
      });
      return <DataTablePagination table={table} />;
    }

    render(<EmptyPaginationExample />);

    expect(screen.getByText("Page 1 of 1")).toBeDefined();
    expect(screen.getByRole("button", { name: "Go to Previous Page" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Go to Next Page" }).hasAttribute("disabled")).toBe(true);
  });
});
