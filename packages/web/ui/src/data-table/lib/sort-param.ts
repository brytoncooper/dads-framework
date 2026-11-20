import { z } from "zod";

import { sortingItemSchema } from "./parsers.js";

/** One column of a sort order, as the URL carries it. */
export type SortParamItem = z.infer<typeof sortingItemSchema>;

const COLUMN_SEPARATOR = ",";
const DESCENDING_SUFFIX = ".desc";
const ASCENDING_SUFFIX = ".asc";
const DESCENDING_PREFIX = "-";
const ASCENDING_PREFIX = "+";

/**
 * Write a sort order as one readable `sort` param.
 *
 * Ascending is the assumed direction, so it is the bare column id; descending
 * carries a suffix; extra columns follow in order:
 *
 * ```
 * []                                        -> undefined (no param at all)
 * [{ id: "name", desc: false }]             -> "name"
 * [{ id: "name", desc: true }]              -> "name.desc"
 * [{ id: "status", desc: true }, { id: "createdAt", desc: false }]
 *                                           -> "status.desc,createdAt"
 * ```
 */
export function encodeSortParam(
  sort: readonly SortParamItem[],
): string | undefined {
  if (sort.length === 0) return undefined;

  return sort
    .map((item) => (item.desc ? `${item.id}${DESCENDING_SUFFIX}` : item.id))
    .join(COLUMN_SEPARATOR);
}

/**
 * Read a `sort` param, accepting every spelling a human might reasonably type.
 *
 * `name`, `name.asc` and `+name` all mean ascending; `name.desc` and `-name`
 * mean descending. A token that names no column is dropped rather than turned
 * into a sort on the empty string.
 */
export function decodeSortParam(value: string): SortParamItem[] {
  const sort: SortParamItem[] = [];

  for (const token of value.split(COLUMN_SEPARATOR)) {
    const item = decodeSortToken(token.trim());
    if (item) sort.push(item);
  }

  return sort;
}

function decodeSortToken(token: string): SortParamItem | undefined {
  if (token.startsWith(DESCENDING_PREFIX)) {
    return columnSort(token.slice(DESCENDING_PREFIX.length), true);
  }
  if (token.startsWith(ASCENDING_PREFIX)) {
    return columnSort(token.slice(ASCENDING_PREFIX.length), false);
  }
  if (token.endsWith(DESCENDING_SUFFIX)) {
    return columnSort(token.slice(0, -DESCENDING_SUFFIX.length), true);
  }
  if (token.endsWith(ASCENDING_SUFFIX)) {
    return columnSort(token.slice(0, -ASCENDING_SUFFIX.length), false);
  }
  return columnSort(token, false);
}

function columnSort(id: string, desc: boolean): SortParamItem | undefined {
  return id.length === 0 ? undefined : { id, desc };
}

/**
 * The `sort` param on the way in: the compact spelling this module writes, or
 * the JSON array links minted before it still carry.
 */
export const sortParamSchema = z
  .union([z.string(), z.array(sortingItemSchema)])
  .transform((value) =>
    typeof value === "string" ? decodeSortParam(value) : value,
  );
