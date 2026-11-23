import type * as React from "react";

/** A row's group: the key that decides where a group starts, and its heading. */
export type DataTableRowGroup = {
  readonly key: string;
  readonly label: React.ReactNode;
};

export type DataTableRowGroupOf<TData> = (row: TData) => DataTableRowGroup;

/** Whether the row at `index` opens a new group: the first row, or a key change. */
export function startsRowGroup<TData>(
  rows: readonly { readonly original: TData }[],
  index: number,
  rowGroupOf: DataTableRowGroupOf<TData>,
): boolean {
  const row = rows[index];
  if (row === undefined) return false;
  const previous = rows[index - 1];
  return previous === undefined || rowGroupOf(previous.original).key !== rowGroupOf(row.original).key;
}
