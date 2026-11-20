import type { Column, Table } from "@tanstack/react-table";

import { showEveryHideableColumn } from "./column-roles.js";

/** The columns a reader may hide or show from the Columns menu, in table order. */
export function readReaderHideableColumns<TData>(
  table: Table<TData>,
): Column<TData>[] {
  return table.getAllLeafColumns().filter((column) => column.getCanHide());
}

/** How many columns the reader could show again right now. */
export function countReaderHiddenColumns<TData>(table: Table<TData>): number {
  return readReaderHideableColumns(table).filter(
    (column) => !column.getIsVisible(),
  ).length;
}

/**
 * Show every column the reader may hide, in one state change. Columns the page
 * itself switched off for a mode (not reader-hideable) stay as the page set them.
 */
export function showAllColumns<TData>(table: Table<TData>): void {
  const ids = readReaderHideableColumns(table).map((column) => column.id);
  table.setColumnVisibility((current) => showEveryHideableColumn(current, ids));
}
