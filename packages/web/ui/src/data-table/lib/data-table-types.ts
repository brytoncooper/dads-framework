import type { ColumnSort, Row } from "@tanstack/react-table";
import type * as React from "react";

import type { StatusTone } from "../../display/index.js";

import type { DataTableConfig } from "../config/data-table.js";
import type { FilterItemSchema } from "./parsers.js";

export type {} from "./table-metadata.js";

/** One selectable value for a `select` / `multiSelect` filter. */
export type Option = {
  label: string;
  value: string;
  count?: number;
  icon?: React.ComponentType<React.ComponentProps<"svg">>;
  /** Uses the shared semantic status treatment when the option represents state. */
  badgeTone?: StatusTone;
};

export type FilterOperator = DataTableConfig["operators"][number];
export type FilterVariant = DataTableConfig["filterVariants"][number];
export type JoinOperator = DataTableConfig["joinOperators"][number];

/** A column id proven to name a field of the row type. */
export type DataTableColumnId<TData> = Extract<keyof TData, string>;

export type ExtendedColumnSort<TData> = Omit<ColumnSort, "id"> & {
  id: DataTableColumnId<TData>;
};

export type ExtendedColumnFilter<TData> = FilterItemSchema & {
  id: DataTableColumnId<TData>;
};

export type DataTableRowAction<TData> = {
  row: Row<TData>;
  variant: "update" | "delete";
};

/**
 * The advanced-filter half of the table state.
 *
 * `DataTableFilterList` and `DataTableFilterMenu` own no state of their own —
 * they read this off `table.options.meta` and call back into whoever supplied
 * it (URL search params, or `useDataTable`'s local fallback).
 */
export type DataTableFilterState<TData> = {
  filters: ExtendedColumnFilter<TData>[];
  onFiltersChange: (filters: ExtendedColumnFilter<TData>[]) => void;
  joinOperator: JoinOperator;
  onJoinOperatorChange: (joinOperator: JoinOperator) => void;
};
