import {
  type ColumnFiltersState,
  functionalUpdate,
  getCoreRowModel,
  getFacetedMinMaxValues,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type PaginationState,
  type RowSelectionState,
  type SortingState,
  type TableOptions,
  type TableState,
  type Updater,
  useReactTable,
} from "@tanstack/react-table";
import * as React from "react";

import { toColumnFilters, toUrlFilters } from "../lib/column-filters.js";
import {
  type DataTableState,
  DEFAULT_PER_PAGE,
  defaultDataTableState,
} from "../lib/data-table-search-params.js";
import type {
  ExtendedColumnFilter,
  ExtendedColumnSort,
  FilterVariant,
  JoinOperator,
} from "../lib/data-table-types.js";
import { parseSortingState } from "../lib/parsers.js";
import { useReaderColumnLayout } from "./use-reader-column-layout.js";

type DataTableInitialState<TData> = Omit<Partial<TableState>, "sorting"> & {
  sorting?: ExtendedColumnSort<TData>[];
};

type UseDataTableProps<TData> = Omit<
  TableOptions<TData>,
  | "state"
  | "pageCount"
  | "getCoreRowModel"
  | "manualFiltering"
  | "manualPagination"
  | "manualSorting"
  // `onStateChange` here means "the shareable state changed", not TanStack's
  // whole-`TableState` updater. Leaving TanStack's in the intersection would
  // demand a callback that satisfied both signatures at once, which nothing
  // can — including the pairing `useDataTableSearchParams` exists to produce.
  | "onStateChange"
> &
  Required<Pick<TableOptions<TData>, "pageCount">> & {
    initialState?: DataTableInitialState<TData>;
    /**
     * Page, page size, sorting and filters, controlled from outside — pair it
     * with `onStateChange`. `useDataTableSearchParams` produces both from a
     * route's URL search params; omit both and the table keeps the state in
     * local React state instead (fully functional, just not shareable).
     */
    state?: DataTableState;
    onStateChange?: (next: DataTableState) => void;
    /**
     * Names this table so the columns a reader hides are remembered on this
     * device (`localStorage`). Unique per table, stable across releases.
     * Omit it and the choice lasts for this visit only.
     */
    tableId?: string;
  };

/**
 * Build the TanStack table, with its shareable state held outside the table.
 *
 * The table is `manual*` on all three axes: sorting, filtering and pagination
 * are the caller's server-side query inputs, and this hook only decides what
 * the next state is.
 *
 * No column is ever hidden for lack of width. The identifying (first) column
 * is pinned left and an `actions` column right, the rest scroll sideways, and
 * only the reader hides columns — through the toolbar's Columns menu.
 */
export function useDataTable<TData>(props: UseDataTableProps<TData>) {
  const {
    pageCount,
    initialState,
    state: stateProp,
    onStateChange: onStateChangeProp,
    enableRowSelection = false,
    tableId,
    columns: callerColumns,
    ...tableProps
  } = props;

  const {
    columns,
    defaultPinning,
    columnVisibility,
    onColumnVisibilityChange,
  } = useReaderColumnLayout({
    callerColumns,
    initialVisibility: initialState?.columnVisibility,
    tableId,
  });

  const [localState, setLocalState] = React.useState<DataTableState>(() =>
    toInitialState(initialState),
  );
  const state = stateProp ?? localState;
  const onStateChange = onStateChangeProp ?? setLocalState;

  const columnVariants = React.useMemo(
    () =>
      new Map(
        columns.flatMap((column) =>
          column.id
            ? [[column.id, column.meta?.variant ?? "text"] as const]
            : [],
        ),
      ),
    [columns],
  );
  const columnIds = React.useMemo(
    () => new Set(columnVariants.keys()),
    [columnVariants],
  );

  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>(
    initialState?.rowSelection ?? {},
  );
  const pinnedInitialState = React.useMemo(
    () => ({
      ...initialState,
      columnPinning: initialState?.columnPinning ?? defaultPinning,
    }),
    [initialState, defaultPinning],
  );

  const pagination = React.useMemo<PaginationState>(
    () => ({ pageIndex: state.page - 1, pageSize: state.perPage }),
    [state.page, state.perPage],
  );

  const sorting = React.useMemo(
    () => parseSortingState<TData>(state.sort, columnIds),
    [state.sort, columnIds],
  );

  const filters = React.useMemo(
    () => toColumnFilters<TData>(state.filters, columnVariants),
    [state.filters, columnVariants],
  );

  const columnFilters = React.useMemo<ColumnFiltersState>(
    () => filters.map((filter) => ({ id: filter.id, value: filter.value })),
    [filters],
  );

  const onPaginationChange = React.useCallback(
    (updaterOrValue: Updater<PaginationState>) => {
      const next = functionalUpdate(updaterOrValue, pagination);
      onStateChange({
        ...state,
        page: next.pageIndex + 1,
        perPage: next.pageSize,
      });
    },
    [pagination, state, onStateChange],
  );

  const onSortingChange = React.useCallback(
    (updaterOrValue: Updater<SortingState>) => {
      const next = functionalUpdate(updaterOrValue, sorting);
      onStateChange({
        ...state,
        sort: next.map((sort) => ({ id: sort.id, desc: sort.desc })),
      });
    },
    [sorting, state, onStateChange],
  );

  const onFiltersChange = React.useCallback(
    (next: ExtendedColumnFilter<TData>[]) => {
      onStateChange({ ...state, filters: toUrlFilters(next, columnVariants) });
    },
    [state, onStateChange, columnVariants],
  );

  const onJoinOperatorChange = React.useCallback(
    (joinOperator: JoinOperator) => {
      onStateChange({ ...state, joinOperator });
    },
    [state, onStateChange],
  );

  const onColumnFiltersChange = React.useCallback(
    (updaterOrValue: Updater<ColumnFiltersState>) => {
      const next = functionalUpdate(updaterOrValue, columnFilters);
      onFiltersChange(mergeColumnFilters(next, filters, columnVariants));
    },
    [columnFilters, filters, columnVariants, onFiltersChange],
  );

  const table = useReactTable({
    ...tableProps,
    columns,
    initialState: pinnedInitialState,
    pageCount,
    state: {
      pagination,
      sorting,
      columnVisibility,
      rowSelection,
      columnFilters,
    },
    defaultColumn: { ...tableProps.defaultColumn, enableColumnFilter: false },
    enableRowSelection,
    onRowSelectionChange: setRowSelection,
    onPaginationChange,
    onSortingChange,
    onColumnFiltersChange,
    onColumnVisibilityChange,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    getFacetedMinMaxValues: getFacetedMinMaxValues(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    meta: {
      ...tableProps.meta,
      dataTableFilterState: {
        filters,
        onFiltersChange,
        joinOperator: state.joinOperator,
        onJoinOperatorChange,
      },
    },
  });

  return React.useMemo(() => ({ table, state }), [table, state]);
}

function toInitialState<TData>(
  initialState?: DataTableInitialState<TData>,
): DataTableState {
  return {
    ...defaultDataTableState,
    page: (initialState?.pagination?.pageIndex ?? 0) + 1,
    perPage: initialState?.pagination?.pageSize ?? DEFAULT_PER_PAGE,
    sort: initialState?.sorting?.map((sort) => ({ ...sort })) ?? [],
  };
}

/**
 * Fold TanStack's `{ id, value }` column filters back into the richer filter
 * items the table works in, keeping the operator each filter already had —
 * the toolbar controls change values, never operators.
 */
function mergeColumnFilters<TData>(
  columnFilters: ColumnFiltersState,
  previous: ExtendedColumnFilter<TData>[],
  columnVariants: ReadonlyMap<string, FilterVariant>,
): ExtendedColumnFilter<TData>[] {
  const previousById = new Map<string, ExtendedColumnFilter<TData>>(
    previous.map((filter) => [filter.id, filter]),
  );

  return toColumnFilters<TData>(
    columnFilters.flatMap((columnFilter) => {
      const value = toFilterValue(columnFilter.value);
      if (value === undefined) return [];

      return [
        {
          id: columnFilter.id,
          operator: previousById.get(columnFilter.id)?.operator,
          value,
        },
      ];
    }),
    columnVariants,
  );
}

function toFilterValue(value: unknown): string | string[] | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return value.toString();
  if (!Array.isArray(value)) return undefined;

  return value.flatMap((item) => {
    if (typeof item === "string") return item;
    if (typeof item === "number") return item.toString();
    return [];
  });
}
