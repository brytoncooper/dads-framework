import type { Table } from "@tanstack/react-table";
/**
 * What: the shared table exposes only real interactions, preserves readable
 * content while updating, and keeps its dense controls consistent.
 * Why: nested clear controls, implicit row selection, and mixed loading/live
 * geometry made every collection inherit the same accessibility and polish
 * defects.
 */
import { type ColumnDef } from "@tanstack/react-table";
import * as React from "react";
import { vi } from "vitest";

import { Button } from "../../../../elements/index.js";

import { useDataTable } from "../../../hooks/use-data-table.js";
import type { DataTableState } from "../../../lib/data-table-search-params.js";
import type { FilterGroup } from "../../../lib/filter-groups.js";
import type { DataTableRowGroupOf } from "../../../lib/row-groups.js";
import { DataTable } from "../data-table.js";
import { DataTableToolbar } from "../data-table-toolbar.js";

export type ExampleRow = {
  name: string;
  status: string;
  createdAt: string;
  amount: number;
};

export const ROWS: ExampleRow[] = [
  {
    name: "North Mill",
    status: "ACTIVE",
    createdAt: "2026-08-19T12:00:00.000Z",
    amount: 12,
  },
];

const fixtureCopy = {
  name: "Name",
  status: "Status",
  search: "Search",
  active: "Active",
  created: "Created",
  amount: "Amount",
  extraFilter: "Extra Filter",
};

export const COLUMNS: ColumnDef<ExampleRow>[] = [
  {
    id: "name",
    accessorKey: "name",
    header: fixtureCopy.name,
    meta: {
      label: fixtureCopy.name,
      variant: "text",
      placeholder: fixtureCopy.search,
    },
    enableColumnFilter: true,
  },
  {
    id: "status",
    accessorKey: "status",
    header: fixtureCopy.status,
    meta: {
      label: fixtureCopy.status,
      variant: "select",
      options: [{ label: fixtureCopy.active, value: "ACTIVE" }],
    },
    enableColumnFilter: true,
  },
  {
    id: "createdAt",
    accessorKey: "createdAt",
    header: fixtureCopy.created,
    meta: { label: fixtureCopy.created, variant: "date" },
    enableColumnFilter: true,
  },
  {
    id: "amount",
    accessorKey: "amount",
    header: fixtureCopy.amount,
    meta: { label: fixtureCopy.amount, variant: "range", range: [0, 100] },
    enableColumnFilter: true,
  },
];

export const FILTERED_STATE: DataTableState = {
  page: 1,
  perPage: 10,
  sort: [],
  filters: [
    { id: "status", value: ["ACTIVE"] },
    { id: "createdAt", value: "1787140800000" },
    { id: "amount", value: ["10", "20"] },
  ],
  joinOperator: "and",
};

export const UNFILTERED_STATE: DataTableState = {
  ...FILTERED_STATE,
  filters: [],
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

export function installResizeObserver(): void {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Element.prototype.scrollIntoView = vi.fn();
}

export function ExampleTable({
  initialState = UNFILTERED_STATE,
  isUpdating = false,
  enableRowSelection = false,
  withToolbar = false,
  withExtraAction = true,
  trailing,
  chipGroups = [],
  columns = COLUMNS,
  rows = ROWS,
  rowGroupOf,
}: {
  readonly initialState?: DataTableState;
  readonly isUpdating?: boolean;
  readonly enableRowSelection?: boolean;
  readonly withToolbar?: boolean;
  readonly withExtraAction?: boolean;
  readonly trailing?: React.ReactNode;
  readonly chipGroups?: readonly FilterGroup[];
  readonly columns?: ColumnDef<ExampleRow>[];
  readonly rows?: ExampleRow[];
  readonly rowGroupOf?: DataTableRowGroupOf<ExampleRow>;
}) {
  const [state, setState] = React.useState(initialState);
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount: 1,
    state,
    onStateChange: setState,
    enableRowSelection,
  });

  return (
    <DataTable
      data-testid="example-table"
      table={table}
      isUpdating={isUpdating}
      withSelectionStatus={enableRowSelection}
      {...withRowGrouping(rowGroupOf)}
    >
      {withToolbar && (
        <ExampleToolbar table={table} trailing={trailing} chipGroups={chipGroups} withExtraAction={withExtraAction} />
      )}
    </DataTable>
  );
}

function ExampleToolbar({
  table,
  trailing,
  chipGroups,
  withExtraAction,
}: {
  table: Table<ExampleRow>;
  trailing: React.ReactNode;
  chipGroups: readonly FilterGroup[];
  withExtraAction: boolean;
}) {
  return (
    <DataTableToolbar table={table} trailing={trailing} chipGroups={chipGroups}>
      {withExtraAction ? <Button variant="outline">{fixtureCopy.extraFilter}</Button> : null}
    </DataTableToolbar>
  );
}

function withRowGrouping(rowGroupOf: DataTableRowGroupOf<ExampleRow> | undefined) {
  return rowGroupOf ? { rowGroupOf } : {};
}
