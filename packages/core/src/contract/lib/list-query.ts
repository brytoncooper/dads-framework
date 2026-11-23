import { z } from "zod";
import { paginationQuerySchema } from "./pagination.schema.js";

/**
 * Sort keys: `field` ascending, `-field` descending
 * (api-conventions.md#filtering-and-sorting).
 */
export function sortKeys<const TFields extends readonly [string, ...string[]]>(
  fields: TFields,
) {
  const keys: (TFields[number] | `-${TFields[number]}`)[] = [];
  for (const field of fields) {
    keys.push(field, `-${field}`);
  }
  return z
    .enum(keys)
    .meta({ description: "Sort key; -field sorts descending" });
}

/**
 * Collection query: pagination plus this endpoint's filters and sort.
 * Inherits strictness from `paginationQuerySchema` — unknown params are 400.
 */
export function listQuery<TFilters extends z.ZodRawShape>(filters: TFilters) {
  return paginationQuerySchema.extend(filters);
}
