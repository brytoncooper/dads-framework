/**
 * What: shared table commands and action labels follow the English Title Case
 * contract across basic, advanced, empty, and pagination controls.
 * Why: these controls appear on every collection page, so one sentence-case
 * label makes the same action read differently throughout the application.
 * @vitest-environment jsdom
 */
import type { ColumnDef } from "@tanstack/react-table";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { useDataTable } from "../../hooks/use-data-table.js";
import type { DataTableState } from "../../lib/data-table-search-params.js";
import { DataTable } from "./data-table.js";
import { DataTableFacetedFilter } from "./data-table-faceted-filter.js";
import { DataTableFilterList } from "./data-table-filter-list.js";
import { DataTableFilterMenu } from "./data-table-filter-menu.js";
import { DataTablePagination } from "./data-table-pagination.js";
import { DataTableSkeleton } from "./data-table-skeleton.js";
import { DataTableSortList } from "./data-table-sort-list.js";
import { DataTableToolbar } from "./data-table-toolbar.js";

type ExampleRow = {
  name: string;
  status: string;
};

const ROWS: ExampleRow[] = [{ name: "North Mill", status: "ACTIVE" }];

const COLUMNS: ColumnDef<ExampleRow>[] = [
  {
    id: "name",
    accessorKey: "name",
    header: "Name",
    meta: { label: "Name", variant: "text", placeholder: "Search" },
    enableColumnFilter: true,
  },
  {
    id: "status",
    accessorKey: "status",
    header: "Status",
    meta: {
      label: "Status",
      variant: "select",
      options: [{ label: "Active", value: "ACTIVE" }],
    },
    enableColumnFilter: true,
  },
];

const FILTERED_STATE: DataTableState = {
  page: 1,
  perPage: 10,
  sort: [],
  filters: [
    { id: "status", value: ["ACTIVE"] },
    { id: "name", value: "North" },
  ],
  joinOperator: "and",
};

const SORTED_STATE: DataTableState = {
  ...FILTERED_STATE,
  filters: [],
  sort: [{ id: "name", desc: false }],
};

/** The command menu measures itself in browsers; jsdom has no observer. */
class ResizeObserverStub {
  observe(): undefined {
    return undefined;
  }
  unobserve(): undefined {
    return undefined;
  }
  disconnect(): undefined {
    return undefined;
  }
}

const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView",
);

type Surface =
  | "empty"
  | "faceted"
  | "filter-list"
  | "filter-menu"
  | "pagination"
  | "sort-list"
  | "toolbar";

function ExampleSurface({
  surface,
  initialState = FILTERED_STATE,
}: {
  readonly surface: Surface;
  readonly initialState?: DataTableState;
}) {
  const [state, setState] = React.useState(initialState);
  const { table } = useDataTable({
    data: surface === "empty" ? [] : ROWS,
    columns: COLUMNS,
    pageCount: 1,
    state,
    onStateChange: setState,
  });

  switch (surface) {
    case "empty":
      return <DataTable table={table} />;
    case "faceted": {
      const column = table.getColumn("status");
      return (
        <DataTableFacetedFilter
          {...(column ? { column } : {})}
          title="Status"
          options={[{ label: "Active", value: "ACTIVE" }]}
        />
      );
    }
    case "filter-list":
      return <DataTableFilterList table={table} debounceMs={0} />;
    case "filter-menu":
      return <DataTableFilterMenu table={table} debounceMs={0} />;
    case "pagination":
      return <DataTablePagination table={table} />;
    case "sort-list":
      return <DataTableSortList table={table} />;
    case "toolbar":
      return <DataTableToolbar table={table} />;
  }
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);
afterAll(() => {
  if (originalScrollIntoView === undefined) {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  } else {
    Object.defineProperty(
      Element.prototype,
      "scrollIntoView",
      originalScrollIntoView,
    );
  }
  vi.unstubAllGlobals();
});

describe("DataTable English chrome", () => {
  it("announces loading while hiding decorative table geometry", () => {
    const { rerender } = render(
      <DataTableSkeleton columnCount={2} rowCount={2} />,
    );

    const loadingTable = screen.getByRole("status", {
      name: "Loading Table",
    });
    expect(
      loadingTable.querySelector("table")?.getAttribute("aria-hidden"),
    ).toBe("true");

    rerender(
      <DataTableSkeleton
        columnCount={2}
        rowCount={2}
        loadingLabel="Loading Organizations"
      />,
    );
    expect(
      screen.getByRole("status", { name: "Loading Organizations" }),
    ).toBeDefined();
  });

  it("uses Title Case for toolbar and pagination actions", () => {
    const { rerender } = render(<ExampleSurface surface="toolbar" />);

    expect(screen.getByRole("textbox", { name: "Search Name" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Reset Filters" })).toBeDefined();
    expect(
      screen.queryByRole("combobox", { name: "Toggle Columns" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "View" })).toBeNull();

    rerender(<ExampleSurface surface="pagination" />);
    expect(screen.getByText("Rows per Page")).toBeDefined();
    expect(
      screen.getByRole("combobox", { name: "Rows per Page" }),
    ).toBeDefined();
    for (const name of [
      "Go to First Page",
      "Go to Previous Page",
      "Go to Next Page",
      "Go to Last Page",
    ]) {
      expect(screen.getByRole("button", { name })).toBeDefined();
    }
  });

  it("uses Title Case for compact filter menu actions", () => {
    render(<ExampleSurface surface="filter-menu" />);

    expect(
      screen.getByRole("button", { name: "Reset All Filters" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Open Filter Menu" }),
    ).toBeDefined();
  });

  it("uses Title Case for advanced filter commands", () => {
    render(<ExampleSurface surface="filter-list" />);

    fireEvent.click(screen.getByRole("button", { name: /^Filter/ }));
    expect(screen.getByRole("button", { name: "Add Filter" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Reset Filters" })).toBeDefined();
    expect(
      screen.getByRole("combobox", { name: "Combine Filters" }),
    ).toBeDefined();
  });

  it("uses Title Case for advanced sorting commands", () => {
    render(<ExampleSurface surface="sort-list" initialState={SORTED_STATE} />);

    fireEvent.click(screen.getByRole("button", { name: /^Sort/ }));
    expect(screen.getByRole("button", { name: "Add Sort" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Reset Sorting" })).toBeDefined();
  });

  it("uses Title Case for both empty-table and faceted clear commands", () => {
    const { rerender } = render(<ExampleSurface surface="empty" />);

    expect(screen.getByRole("button", { name: "Clear Filters" })).toBeDefined();

    rerender(<ExampleSurface surface="faceted" />);
    const trigger = screen.getByText("Status").closest("button");
    expect(trigger).not.toBeNull();
    if (trigger === null) throw new Error("Status filter trigger is missing");
    fireEvent.click(trigger);
    expect(screen.getByText("Clear Filters")).toBeDefined();
  });
});
