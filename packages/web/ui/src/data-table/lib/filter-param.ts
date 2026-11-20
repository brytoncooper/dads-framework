import { z } from "zod";

import { dataTableConfig } from "../config/data-table.js";
import type { FilterOperator } from "./data-table-types.js";

/**
 * One filter as a link may spell it: which column, what it is compared to, and
 * the operator only when the reader chose one the column would not have
 * assumed.
 *
 * `variant` and `filterId` are accepted because links minted before the
 * compact grammar carry them — the table takes both from its own column meta
 * (`toColumnFilters`), so neither is ever written back out.
 */
export const filterItemParamSchema = z.object({
  id: z.string(),
  value: z.union([z.string(), z.array(z.string())]),
  operator: z.enum(dataTableConfig.operators).optional(),
  variant: z.enum(dataTableConfig.filterVariants).optional(),
  filterId: z.string().optional(),
});

export type FilterParamItem = z.infer<typeof filterItemParamSchema>;

/**
 * The `filters` param on the way in: the compact grammar this module writes,
 * or the JSON array links minted before it still carry.
 */
export const filterParamSchema = z
  .union([z.string(), z.array(filterItemParamSchema)])
  .transform((value) =>
    typeof value === "string" ? decodeFilterParam(value) : value,
  );

const FILTER_SEPARATOR = "*";
const FIELD_SEPARATOR = ".";
const VALUE_SEPARATOR = ",";
const ESCAPE = "\\";

/**
 * Write the active filters as one readable `filters` param.
 *
 * ```
 * []                                          -> undefined (no param at all)
 * [{ id: "status", value: "ACTIVE" }]         -> "status.ACTIVE"
 * [{ id: "status", value: ["ACTIVE", "ARCHIVED"] }]
 *                                             -> "status.ACTIVE,ARCHIVED"
 * [{ id: "createdAt", operator: "gte", value: "2026-01-01" }]
 *                                             -> "createdAt.gte.2026-01-01"
 * two filters                                 -> "status.ACTIVE*name.feeds"
 * ```
 *
 * `*`, `,` and `\` inside a column id or a value are escaped with a
 * backslash. A `.` inside a value is not: the value is everything left after
 * the column (and the operator, when one is spelled out), dots included, so
 * `name.test.org` searches for `test.org`.
 */
export function encodeFilterParam(
  filters: readonly FilterParamItem[],
): string | undefined {
  if (filters.length === 0) return undefined;

  return filters.map(encodeFilter).join(FILTER_SEPARATOR);
}

/** Read a `filters` param, dropping any token that names no value. */
export function decodeFilterParam(value: string): FilterParamItem[] {
  const filters: FilterParamItem[] = [];

  for (const token of splitUnescaped(value, FILTER_SEPARATOR)) {
    const filter = decodeFilter(token);
    if (filter) filters.push(filter);
  }

  return filters;
}

function encodeFilter(filter: FilterParamItem): string {
  const fields = [escapeField(filter.id)];
  if (filter.operator) fields.push(filter.operator);
  fields.push(encodeValues(filter.value, filter.operator !== undefined));

  return fields.join(FIELD_SEPARATOR);
}

function encodeValues(value: string | string[], hasOperator: boolean): string {
  const values = Array.isArray(value) ? value : [value];
  const encoded = values.map(escapeValue).join(VALUE_SEPARATOR);

  return hasOperator ? encoded : keepOperatorLookalikeWhole(encoded);
}

/**
 * `name` filtered on the text `gte.foo` would otherwise read back as the
 * column `name` compared with `gte` — so that one dot earns an escape.
 */
function keepOperatorLookalikeWhole(encoded: string): string {
  const [first, ...rest] = splitUnescaped(encoded, FIELD_SEPARATOR);
  if (first === undefined || rest.length === 0) return encoded;
  if (!isFilterOperator(first)) return encoded;

  return `${first}${ESCAPE}${FIELD_SEPARATOR}${rest.join(FIELD_SEPARATOR)}`;
}

function decodeFilter(token: string): FilterParamItem | undefined {
  const fields = splitUnescaped(token, FIELD_SEPARATOR);
  const [rawId, second] = fields;
  if (rawId === undefined || rawId === "" || fields.length < 2)
    return undefined;

  const id = unescape(rawId);
  const hasOperator = fields.length > 2 && isFilterOperator(second);
  const valueFields = fields.slice(hasOperator ? 2 : 1);
  const value = decodeValues(valueFields.join(FIELD_SEPARATOR));

  return hasOperator ? { id, operator: second, value } : { id, value };
}

function decodeValues(encoded: string): string | string[] {
  const values = splitUnescaped(encoded, VALUE_SEPARATOR).map(unescape);
  if (values.length > 1) return values;

  return values[0] ?? "";
}

function isFilterOperator(value: string | undefined): value is FilterOperator {
  return dataTableConfig.operators.some((operator) => operator === value);
}

function escapeField(field: string): string {
  return field.replace(/[\\.,*]/g, (character) => `${ESCAPE}${character}`);
}

function escapeValue(value: string): string {
  return value.replace(/[\\,*]/g, (character) => `${ESCAPE}${character}`);
}

function unescape(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}

/**
 * Split on a separator the way the grammar means it — a separator that a
 * backslash spoke for belongs to the text, not to the structure. Escapes are
 * left in place so the pieces can be rejoined before `unescape` runs.
 */
function splitUnescaped(text: string, separator: string): string[] {
  const pieces: string[] = [];
  let piece = "";
  let spokenFor = false;

  for (const character of text) {
    if (spokenFor) {
      piece += character;
      spokenFor = false;
      continue;
    }
    if (character === ESCAPE) {
      piece += character;
      spokenFor = true;
      continue;
    }
    if (character === separator) {
      pieces.push(piece);
      piece = "";
      continue;
    }
    piece += character;
  }
  pieces.push(piece);

  return pieces;
}
