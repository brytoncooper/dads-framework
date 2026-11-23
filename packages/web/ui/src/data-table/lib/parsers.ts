import { z } from "zod";

import { dataTableConfig } from "../config/data-table.js";
import type { DataTableColumnId, ExtendedColumnSort } from "./data-table-types.js";

export const sortingItemSchema = z.object({
  id: z.string(),
  desc: z.boolean(),
});

export const filterItemSchema = z.object({
  id: z.string(),
  value: z.union([z.string(), z.array(z.string())]),
  variant: z.enum(dataTableConfig.filterVariants),
  operator: z.enum(dataTableConfig.operators),
  filterId: z.string(),
});

export type FilterItemSchema = z.infer<typeof filterItemSchema>;

/**
 * Narrow a runtime column id to a field of the row type.
 *
 * The membership test is the proof: a column id that the table itself
 * publishes names an accessor on `TData`. Callers pass `TData` explicitly —
 * `isKnownColumnId<Task>(id, columnIds)`.
 */
export function isKnownColumnId<TData>(
  id: string,
  columnIds: { has: (id: string) => boolean },
): id is DataTableColumnId<TData> {
  return columnIds.has(id);
}

/** Read a sorting state out of unknown (URL-supplied) data, dropping junk. */
export function parseSortingState<TData>(value: unknown, columnIds: ReadonlySet<string>): ExtendedColumnSort<TData>[] {
  const parsed = z.array(sortingItemSchema).safeParse(value);
  if (!parsed.success) return [];

  const sorting: ExtendedColumnSort<TData>[] = [];
  for (const item of parsed.data) {
    if (!isKnownColumnId<TData>(item.id, columnIds)) continue;
    sorting.push({ id: item.id, desc: item.desc });
  }
  return sorting;
}
