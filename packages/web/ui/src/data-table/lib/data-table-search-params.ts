import { z } from "zod";

import { dataTableConfig } from "../config/data-table.js";
import type { JoinOperator } from "./data-table-types.js";
import { encodeFilterParam, filterParamSchema } from "./filter-param.js";
import { encodeSortParam, sortParamSchema } from "./sort-param.js";

export const DEFAULT_PAGE = 1;
export const DEFAULT_PER_PAGE = 25;
export const MAX_PER_PAGE = 100;
export const DEFAULT_JOIN_OPERATOR: JoinOperator = "and";

/**
 * The table's slice of a route's URL search params.
 *
 * Spread into a route's own search schema so the two validate together, and
 * pair it with `dataTableSearchMiddlewares` so the URL only ever carries what
 * deviates from the default view:
 *
 * ```ts
 * export const Route = createFileRoute("/machines")({
 *   validateSearch: z.object({
 *     ...dataTableSearchSchema.shape,
 *     view: z.enum(["grid", "list"]).catch("list"),
 *   }),
 *   search: { middlewares: dataTableSearchMiddlewares },
 * });
 * ```
 *
 * Every field carries `.catch(...)`, so a hand-mangled or stale URL degrades
 * to the default view instead of throwing at the route boundary, and
 * `.default(...)`, so an absent param is the default view and a link needs to
 * pass none of them.
 */
export const dataTableSearchSchema = z.object({
  page: z.coerce
    .number()
    .int()
    .min(1)
    .catch(DEFAULT_PAGE)
    .default(DEFAULT_PAGE),
  perPage: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PER_PAGE)
    .catch(DEFAULT_PER_PAGE)
    .default(DEFAULT_PER_PAGE),
  sort: sortParamSchema.catch([]).default([]),
  filters: filterParamSchema.catch([]).default([]),
  joinOperator: z
    .enum(dataTableConfig.joinOperators)
    .catch(DEFAULT_JOIN_OPERATOR)
    .default(DEFAULT_JOIN_OPERATOR),
});

/**
 * The table state a URL carries. Row-type free on purpose: this is the wire
 * shape, and `useDataTable` is what narrows column ids against its columns.
 */
export type DataTableState = z.infer<typeof dataTableSearchSchema>;

export const defaultDataTableState: DataTableState = {
  page: DEFAULT_PAGE,
  perPage: DEFAULT_PER_PAGE,
  sort: [],
  filters: [],
  joinOperator: DEFAULT_JOIN_OPERATOR,
};

/** Keep only the table's keys — a route's other search params are not ours. */
export function pickDataTableState(search: DataTableState): DataTableState {
  return {
    page: search.page,
    perPage: search.perPage,
    sort: search.sort,
    filters: search.filters,
    joinOperator: search.joinOperator,
  };
}

/**
 * The table state on its way back out to the URL: `undefined` wherever the
 * reader is looking at the default view, because a param equal to its default
 * is noise that never survives being read aloud or pasted into chat.
 */
export type DataTableSearchParams = {
  page: number | undefined;
  perPage: number | undefined;
  sort: string | undefined;
  filters: string | undefined;
  joinOperator: JoinOperator | undefined;
};

export function toDataTableSearchParams(
  state: DataTableState,
): DataTableSearchParams {
  return {
    page: state.page === DEFAULT_PAGE ? undefined : state.page,
    perPage: state.perPage === DEFAULT_PER_PAGE ? undefined : state.perPage,
    sort: encodeSortParam(state.sort),
    filters: encodeFilterParam(state.filters),
    joinOperator:
      state.joinOperator === DEFAULT_JOIN_OPERATOR
        ? undefined
        : state.joinOperator,
  };
}

/**
 * A TanStack Router search middleware — kept structural so this lib stays
 * router-free — that rewrites the table's params after the route has
 * validated them.
 *
 * It runs outermost, so what it receives from `next` is the fully defaulted
 * state the route reads, and what it returns is what the URL shows. Nothing
 * is lost: `dataTableSearchSchema` reads every param back on the next match.
 */
export function compactDataTableSearchParams<TSearch>(context: {
  search: TSearch;
  next: (search: TSearch) => TSearch;
}): TSearch {
  const validated = context.next(context.search);
  const state = dataTableSearchSchema.safeParse(validated);
  if (!state.success) return validated;

  return { ...validated, ...toDataTableSearchParams(state.data) };
}

/** Drop straight into a route's `search: { middlewares }`. */
export const dataTableSearchMiddlewares = [compactDataTableSearchParams];

/**
 * Page 7 of the old filter is not page 7 of the new one, so any change that
 * reshapes the result set sends the reader back to the first page.
 */
export function withPageResetOnNarrowing(
  previous: DataTableState,
  next: DataTableState,
): DataTableState {
  if (next.page !== previous.page) return next;
  return { ...next, page: narrowsResults(previous, next) ? 1 : next.page };
}

function narrowsResults(previous: DataTableState, next: DataTableState) {
  return (
    previous.perPage !== next.perPage ||
    previous.joinOperator !== next.joinOperator ||
    !sameJson(previous.sort, next.sort) ||
    !sameJson(previous.filters, next.filters)
  );
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}
