import type { Column, Table } from "@tanstack/react-table";

import { dataTableConfig } from "../config/data-table.js";
import type { DataTableCopyKey } from "../copy/data-table-copy.js";
import type {
  DataTableFilterState,
  ExtendedColumnFilter,
  FilterOperator,
  FilterVariant,
} from "./data-table-types.js";

/**
 * The advanced-filter state `useDataTable` published on the table.
 *
 * `DataTableFilterList` and `DataTableFilterMenu` are useless without it, so
 * a table built by hand fails loudly here rather than rendering controls that
 * silently do nothing.
 */
export function readDataTableFilterState<TData>(
  table: Table<TData>,
): DataTableFilterState<TData> {
  const filterState = table.options.meta?.dataTableFilterState;
  if (!filterState) {
    throw new Error(
      "Advanced filtering needs a table built with useDataTable() — it is what publishes meta.dataTableFilterState.",
    );
  }
  return filterState;
}

/**
 * Inline geometry for a header or body cell of a pinned column: sticky, offset
 * past the columns pinned before it, with an edge shadow on the last left and
 * first right pinned cell when `withBorder` is set.
 *
 * The opaque surface and stacking come from the display kit's `data-pinned`
 * cell styles (pair this with {@link readPinnedAttribute}), not an inline
 * background — an inline background would paint over the row's hover and
 * selected wash.
 */
export function getColumnPinningStyle<TData>({
  column,
  withBorder = false,
}: {
  column: Column<TData>;
  withBorder?: boolean;
}): React.CSSProperties {
  const isPinned = column.getIsPinned();
  const isLastLeftPinnedColumn =
    isPinned === "left" && column.getIsLastColumn("left");
  const isFirstRightPinnedColumn =
    isPinned === "right" && column.getIsFirstColumn("right");

  return {
    boxShadow: withBorder
      ? isLastLeftPinnedColumn
        ? "-4px 0 4px -4px var(--border) inset"
        : isFirstRightPinnedColumn
          ? "4px 0 4px -4px var(--border) inset"
          : undefined
      : undefined,
    left: isPinned === "left" ? `${column.getStart("left")}px` : undefined,
    right: isPinned === "right" ? `${column.getAfter("right")}px` : undefined,
    position: isPinned ? "sticky" : undefined,
  };
}

/**
 * The inline width of a column's header and body cells. A column keeps its
 * pixel `size` unless its `meta.width` says otherwise: `"fit"` asks for 1px,
 * which an auto-layout table grows to the column's widest cell, and a
 * `{ fillShare }` column gets its share of 100% among the visible fill
 * columns, so together they take whatever width the other columns leave.
 */
export function readColumnWidth<TData>(
  column: Column<TData>,
  visibleColumns: readonly Column<TData>[],
): number | string {
  const width = column.columnDef.meta?.width;
  if (width === undefined) return column.getSize();
  if (width === "fit") return 1;
  const totalFillShare = visibleColumns.reduce(
    (total, visibleColumn) => total + readFillShare(visibleColumn),
    0,
  );
  return `${(width.fillShare / totalFillShare) * 100}%`;
}

function readFillShare<TData>(column: Column<TData>): number {
  const width = column.columnDef.meta?.width;
  return width === undefined || width === "fit" ? 0 : width.fillShare;
}

/** The `data-pinned` value that gives a pinned cell its opaque surface, or undefined. */
export function readPinnedAttribute<TData>(
  column: Column<TData>,
): "left" | "right" | undefined {
  const isPinned = column.getIsPinned();
  return isPinned === false ? undefined : isPinned;
}

export function getFilterOperators(filterVariant: FilterVariant) {
  const operatorMap: Record<
    FilterVariant,
    readonly { labelKey: DataTableCopyKey; value: FilterOperator }[]
  > = {
    text: dataTableConfig.textOperators,
    number: dataTableConfig.numericOperators,
    range: dataTableConfig.numericOperators,
    date: dataTableConfig.dateOperators,
    dateRange: dataTableConfig.dateOperators,
    boolean: dataTableConfig.booleanOperators,
    select: dataTableConfig.selectOperators,
    multiSelect: dataTableConfig.multiSelectOperators,
  };

  return operatorMap[filterVariant];
}

export function getDefaultFilterOperator(filterVariant: FilterVariant) {
  const operators = getFilterOperators(filterVariant);

  return operators[0]?.value ?? (filterVariant === "text" ? "iLike" : "eq");
}

export function getValidFilters<TData>(
  filters: ExtendedColumnFilter<TData>[],
): ExtendedColumnFilter<TData>[] {
  return filters.filter(
    (filter) =>
      filter.operator === "isEmpty" ||
      filter.operator === "isNotEmpty" ||
      (Array.isArray(filter.value)
        ? filter.value.length > 0
        : filter.value !== ""),
  );
}
