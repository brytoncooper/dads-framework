import type { RowData, Table } from "@tanstack/react-table";

function columnFilterCanClear<TData extends RowData>(table: Table<TData>, columnId: string): boolean {
  return table.getColumn(columnId)?.columnDef.meta?.canClearFilter !== false;
}

export function hasClearableColumnFilters<TData extends RowData>(table: Table<TData>): boolean {
  return table.getState().columnFilters.some((filter) => columnFilterCanClear(table, filter.id));
}

/** How many column filters are set that the reader may clear. */
export function countClearableColumnFilters<TData extends RowData>(table: Table<TData>): number {
  return table.getState().columnFilters.filter((filter) => columnFilterCanClear(table, filter.id)).length;
}

export function clearClearableColumnFilters<TData extends RowData>(table: Table<TData>): void {
  table.setColumnFilters((filters) => filters.filter((filter) => !columnFilterCanClear(table, filter.id)));
}
