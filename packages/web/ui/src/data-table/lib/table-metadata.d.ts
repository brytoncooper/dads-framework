import type { RowData } from "@tanstack/react-table";
import type * as React from "react";

import type { DataTableFilterState, FilterVariant, Option } from "./data-table-types.js";

declare module "@tanstack/react-table" {
  interface TableMeta<TData extends RowData> {
    /**
     * Advanced-filter state, published by `useDataTable` so
     * `DataTableFilterList` and `DataTableFilterMenu` can read and write it
     * through the `table` they already receive.
     */
    dataTableFilterState?: DataTableFilterState<TData>;
  }

  interface ColumnMeta<TData extends RowData, TValue> {
    label?: string;
    placeholder?: string;
    variant?: FilterVariant;
    options?: Option[];
    range?: [number, number];
    unit?: string;
    icon?: React.ComponentType<React.ComponentProps<"svg">>;
    /** False when the filter is a required list view, not an optional refinement. */
    canClearFilter?: boolean;
    /**
     * On a phone card, true puts this column among the few fields shown under
     * the heading; false keeps it in the details. Unset columns fill
     * the summary in table order.
     */
    cardSummary?: boolean;
    /** Use this field as the phone card heading when desktop columns start with a code. */
    cardHeading?: boolean;
    /** Extra classes for this column's body cells (e.g. `max-w-0` so auto-layout tables truncate text instead of widening the column). */
    cellClassName?: string;
    /**
     * How wide this column's header and body cells are, in place of its
     * pixel `size`. `"fit"` hugs the widest cell, such as a row's action
     * buttons. `{ fillShare }` takes that share of the width the other
     * columns leave, weighed against the table's other fill columns; pair it
     * with `cellClassName: "max-w-0"` and truncating content so a long value
     * clips instead of widening the table.
     */
    width?: "fit" | { fillShare: number };
  }
}
