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
 */
import type { ColumnDef } from "@tanstack/react-table";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import * as React from "react";
import { vi } from "vitest";

import { Button } from "../../../../elements/index.js";

import { useDataTable } from "../../../hooks/use-data-table.js";
import { DataTable } from "../data-table.js";
import { DataTableToolbar } from "../data-table-toolbar.js";

export type Load = {
  id: string;
  ticket: string;
  status: string;
  customer: string;
  product: string;
  carrier: string;
  loadedAt: string;
};

export const LOADS: Load[] = [
  {
    id: "load-1",
    ticket: "T-1001",
    status: "Loaded",
    customer: "North Mill",
    product: "Yellow Corn",
    carrier: "Prairie Freight",
    loadedAt: "Aug 19",
  },
];

const fixtureCopy = {
  ticket: "Ticket",
  status: "Status",
  customer: "Customer",
  product: "Product",
  carrier: "Carrier",
  loaded: "Loaded",
  voidTicket: "Void Ticket",
  searchTickets: "Search Tickets",
  type: "Type",
  sales: "Sales",
  transfers: "Transfers",
};

export const COLUMNS: ColumnDef<Load>[] = [
  {
    id: "ticket",
    accessorKey: "ticket",
    header: fixtureCopy.ticket,
    meta: { label: fixtureCopy.ticket },
    cell: ({ row }) => (
      <a href={`/loads/${row.original.id}`}>{row.original.ticket}</a>
    ),
  },
  {
    id: "status",
    accessorKey: "status",
    header: fixtureCopy.status,
    meta: { label: fixtureCopy.status },
  },
  {
    id: "customer",
    accessorKey: "customer",
    header: fixtureCopy.customer,
    meta: { label: fixtureCopy.customer },
  },
  {
    id: "product",
    accessorKey: "product",
    header: fixtureCopy.product,
    meta: { label: fixtureCopy.product },
  },
  {
    id: "carrier",
    accessorKey: "carrier",
    header: fixtureCopy.carrier,
    meta: { label: fixtureCopy.carrier },
  },
  { id: "loadedAt", accessorKey: "loadedAt", header: () => fixtureCopy.loaded },
  {
    id: "actions",
    cell: () => <Button type="button">{fixtureCopy.voidTicket}</Button>,
  },
];

export const TABLE_ID = "loads-under-test";

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

export function stubViewport({ phone }: { readonly phone: boolean }): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: phone && query.includes("max-width"),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

export function LoadsTable() {
  const { table } = useDataTable({
    data: LOADS,
    columns: COLUMNS,
    pageCount: 1,
    tableId: TABLE_ID,
  });
  return (
    <DataTable table={table}>
      <DataTableToolbar table={table} />
    </DataTable>
  );
}

export const UNLINKED_COLUMNS: ColumnDef<Load>[] = COLUMNS.map((column) => {
  if (column.id !== "ticket") return column;
  const unlinkedColumn = { ...column };
  delete unlinkedColumn.cell;
  return unlinkedColumn;
});

export function UnlinkedLoadsTable() {
  const { table } = useDataTable({
    data: LOADS,
    columns: UNLINKED_COLUMNS,
    pageCount: 1,
    tableId: TABLE_ID,
  });
  return (
    <DataTable table={table}>
      <DataTableToolbar table={table} />
    </DataTable>
  );
}

export function detailLabels(container: HTMLElement): (string | null)[] {
  const details = container.querySelector(
    '[data-slot="data-table-card-details"]',
  );
  return [...(details?.querySelectorAll("dt") ?? [])].map(
    (dt) => dt.textContent,
  );
}

export function openColumnsMenu(): void {
  fireEvent.keyDown(screen.getByRole("button", { name: "Columns" }), {
    key: "Enter",
  });
}

export function headerNames(): string[] {
  return screen
    .getAllByRole("columnheader", { hidden: true })
    .map((header) => header.textContent);
}

export function setUpWidthTests(): void {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Element.prototype.scrollIntoView = vi.fn();
  stubViewport({ phone: false });
}

export function tearDownWidthTests(): void {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
}

export function TypedLoadsTable({
  resultCount,
  addFilter,
}: {
  readonly resultCount?: number;
  readonly addFilter?: React.ReactNode;
}) {
  const [types, setTypes] = React.useState<readonly string[]>([]);
  const { table } = useDataTable({
    data: LOADS,
    columns: COLUMNS,
    pageCount: 1,
  });
  return (
    <DataTable table={table}>
      <DataTableToolbar
        table={table}
        search={<input type="search" aria-label={fixtureCopy.searchTickets} />}
        filterGroups={[
          {
            id: "type",
            label: fixtureCopy.type,
            options: [
              { value: "SALE", label: fixtureCopy.sales },
              { value: "TRANSFER", label: fixtureCopy.transfers },
            ],
            selected: types,
            onSelectedChange: setTypes,
          },
        ]}
        {...(resultCount === undefined ? {} : { resultCount })}
      >
        {addFilter}
      </DataTableToolbar>
    </DataTable>
  );
}
