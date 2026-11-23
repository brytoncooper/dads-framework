import * as React from "react";

import { type DataTableState, pickDataTableState, withPageResetOnNarrowing } from "../lib/data-table-search-params.js";

/** What `useDataTable` needs to run controlled. Spread it straight in. */
export type DataTableStateBinding = {
  state: DataTableState;
  onStateChange: (next: DataTableState) => void;
};

/**
 * Bind a data table's state to a TanStack Router route's search params.
 *
 * The route owns the router primitives (it is the only place they are typed);
 * this hook owns the three things a route would otherwise get wrong — keeping
 * the table's keys separate from the route's own search params, sending the
 * reader back to page 1 whenever the result set is reshaped, and handing
 * `useDataTable` a referentially stable state object.
 *
 * ```tsx
 * const search = Route.useSearch();
 * const navigate = Route.useNavigate();
 * const tableState = useDataTableSearchParams({
 *   search,
 *   onSearchChange: (next) => {
 *     void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
 *   },
 * });
 * const { table } = useDataTable({ data, columns, pageCount, ...tableState });
 * ```
 */
export function useDataTableSearchParams({
  search,
  onSearchChange,
}: {
  search: DataTableState;
  onSearchChange: (next: DataTableState) => void;
}): DataTableStateBinding {
  const { page, perPage, sort, filters, joinOperator } = search;

  const state = React.useMemo<DataTableState>(
    () => ({ page, perPage, sort, filters, joinOperator }),
    [page, perPage, sort, filters, joinOperator],
  );

  const onStateChange = React.useCallback(
    (next: DataTableState) => {
      onSearchChange(withPageResetOnNarrowing(state, pickDataTableState(next)));
    },
    [state, onSearchChange],
  );

  return React.useMemo(() => ({ state, onStateChange }), [state, onStateChange]);
}
