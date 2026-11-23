import type { Column } from "@tanstack/react-table";

import type { LocaleFormatting } from "../../../copy/index.js";

import type { DataTableCopyTranslator } from "../../copy/data-table-copy.js";
import type { ExtendedColumnFilter, FilterOperator, FilterVariant } from "../../lib/data-table-types.js";

/** Keys that remove a filter when pressed on an empty input or a filter chip. */
export const REMOVE_FILTER_SHORTCUTS = ["backspace", "delete"];

export type FilterMenuUpdate<TData> = (
  filterId: string,
  updates: Partial<Omit<ExtendedColumnFilter<TData>, "filterId">>,
) => void;

/** Everything one applied filter's value input needs to render. */
export type FilterMenuInputProps<TData> = {
  filter: ExtendedColumnFilter<TData>;
  column: Column<TData>;
  inputId: string;
  onFilterUpdate: FilterMenuUpdate<TData>;
  showValueSelector: boolean;
  setShowValueSelector: (value: boolean) => void;
  copy: DataTableCopyTranslator;
  formatting: LocaleFormatting;
};

/** A column's filter variant; columns that name none filter as text. */
export function readColumnFilterVariant<TData>(column: Column<TData>): FilterVariant {
  return column.columnDef.meta?.variant ?? "text";
}

/** Operators that test for presence and require no value. */
export function isValuelessOperator(operator: FilterOperator): boolean {
  return operator === "isEmpty" || operator === "isNotEmpty";
}
