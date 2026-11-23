import { type Table as TanstackTable } from "@tanstack/react-table";
import * as React from "react";

import { Button, cn } from "../../../elements/index.js";

import { useDataTableCopy } from "../../copy/data-table-copy.js";
import { useIsPhoneWidth } from "../../hooks/use-is-phone-width.js";
import { clearClearableColumnFilters, hasClearableColumnFilters } from "../../lib/clearable-column-filters.js";
import { type DataTableRowGroupOf } from "../../lib/row-groups.js";
import { DataTableCardList } from "./data-table-card-list.js";
import { DataTableHiddenColumnsNote } from "./data-table-hidden-columns-note.js";
import { DataTablePagination } from "./data-table-pagination.js";

import { DataTableDesktopContent } from "./data-table-desktop-content.js";

type DataTableProps<TData> = React.ComponentProps<"div"> & {
  table: TanstackTable<TData>;
  actionBar?: React.ReactNode;
  /** Keep existing rows readable while a background query refreshes them. */
  isUpdating?: boolean;
  /** Replaces the default `overflow-hidden rounded-md border` frame around the table. */
  contentClassName?: string;
  /** Show the selected-row count only for workflows that opt into selection. */
  withSelectionStatus?: boolean;
  /**
   * What the no-rows row says. Name the resource — "No orders match these filters." beats
   * "No results.", which makes the reader work out what did not match.
   *
   * This row is only ever reached with a filter active: a list that is empty
   * with *no* filter must not render a table at all (see `readListEmptiness`),
   * so the row always offers a way to clear the filter that caused it.
   */
  emptyMessage?: React.ReactNode;
  /**
   * Clears every narrowing the page owns outside the table's column filters:
   * status tabs, direction tabs, date ranges held in search params. When
   * given, the no-rows row always offers Clear Filters and calls this after
   * clearing the clearable column filters. A page whose default view is
   * already narrowed passes it so that view can be widened from its own
   * empty result.
   */
  onClearFilters?: () => void;
  /**
   * Groups the rows on the page under a full-width heading row (a heading on
   * phones) wherever a row's group key differs from the row before it. The
   * caller sorts the rows so each group's rows sit together.
   */
  rowGroupOf?: DataTableRowGroupOf<TData>;
};

/**
 * The shared list table. It never hides a column for lack of width: on wide
 * screens the identifying and actions columns stay pinned while the rest
 * scroll sideways under a soft edge fade, and on phones each row becomes
 * a card that opens its record, or, with no record link, expands to every
 * field, the reader-hidden ones included. Only the reader hides columns, through the toolbar's Columns menu,
 * and a note says so; phones have neither, since their cards hide nothing.
 */
export function DataTable<TData>({
  table,
  actionBar,
  isUpdating = false,
  contentClassName,
  withSelectionStatus = false,
  emptyMessage,
  onClearFilters,
  rowGroupOf,
  children,
  className,
  ...props
}: DataTableProps<TData>) {
  const isPhoneWidth = useIsPhoneWidth();
  const hasRows = table.getRowModel().rows.length > 0;
  const visibleRowGrouping = rowGroupOf ? { rowGroupOf } : {};
  const emptyState = <DataTableEmptyState table={table} emptyMessage={emptyMessage} onClearFilters={onClearFilters} />;
  return (
    <div {...props} data-slot="data-table" className={cn("relative flex min-w-0 w-full flex-col gap-2.5", className)}>
      {isUpdating && <DataTableUpdateStatus />}
      {children}
      {isPhoneWidth ? null : <DataTableHiddenColumnsNote table={table} />}
      {isPhoneWidth ? (
        <div data-slot="data-table-content" aria-busy={isUpdating || undefined}>
          {hasRows ? (
            <DataTableCardList table={table} {...visibleRowGrouping} />
          ) : (
            <div className="flex h-24 items-center justify-center rounded-md border bg-card p-3">{emptyState}</div>
          )}
        </div>
      ) : (
        <DataTableDesktopContent
          table={table}
          isUpdating={isUpdating}
          contentClassName={contentClassName}
          rowGroupOf={rowGroupOf}
          emptyState={emptyState}
          hasRows={hasRows}
        />
      )}
      <div className="flex flex-col gap-2.5">
        <DataTablePagination table={table} withSelectionStatus={withSelectionStatus} />
        {renderSelectionActionBar(table, actionBar)}
      </div>
    </div>
  );
}

function DataTableUpdateStatus() {
  const t = useDataTableCopy();
  return (
    <div
      data-slot="data-table-update-status"
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 top-0 z-40 h-0.5 overflow-hidden rounded-full bg-primary/15"
    >
      <div aria-hidden="true" className="h-full w-full animate-pulse bg-primary motion-reduce:animate-none" />
      <span className="sr-only">{t("dataTable.state.updating")}</span>
    </div>
  );
}

function DataTableEmptyState<TData>({
  table,
  emptyMessage,
  onClearFilters,
}: {
  readonly table: TanstackTable<TData>;
  readonly emptyMessage: React.ReactNode;
  readonly onClearFilters: (() => void) | undefined;
}) {
  const t = useDataTableCopy();
  const offersClearFilters = onClearFilters !== undefined || hasClearableColumnFilters(table);
  return (
    <div className="flex items-center justify-center gap-1.5">
      <span className="text-muted-foreground">
        {emptyMessage ?? t(offersClearFilters ? "dataTable.state.noResults" : "dataTable.state.emptyView")}
      </span>
      {offersClearFilters && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            clearClearableColumnFilters(table);
            onClearFilters?.();
          }}
        >
          {t("dataTable.action.clearFilters")}
        </Button>
      )}
    </div>
  );
}

function renderSelectionActionBar<TData>(table: TanstackTable<TData>, actionBar: React.ReactNode): React.ReactNode {
  return actionBar && table.getFilteredSelectedRowModel().rows.length > 0 && actionBar;
}
