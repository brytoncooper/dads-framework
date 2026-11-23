import type { Column, Table } from "@tanstack/react-table";
import { ListFilter, X } from "lucide-react";
import * as React from "react";

import { FormattedInteger } from "../../../copy/index.js";
import { Badge, Button, cn } from "../../../elements/index.js";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../../../overlays/index.js";

import { useDataTableCopy } from "../../copy/data-table-copy.js";
import { useIsPhoneWidth } from "../../hooks/use-is-phone-width.js";
import {
  clearClearableColumnFilters,
  countClearableColumnFilters,
  hasClearableColumnFilters,
} from "../../lib/clearable-column-filters.js";
import { countAppliedFilterValues, type FilterGroup } from "../../lib/filter-groups.js";
import { AppliedFilterChips } from "./applied-filter-chips.js";
import { DataTableColumnsMenu } from "./data-table-columns-menu.js";
import { FilterGroupToggles } from "./filter-group-toggles.js";
import { FilterPill } from "./filter-pill.js";

import { DataTableToolbarFilter } from "./data-table-toolbar-filter.js";

const CONTROL_SIZING =
  "[&_[data-slot=button]]:h-8 [&_[data-slot=button][data-variant=outline]]:border-input [&_[data-slot=popover-trigger]]:h-8 [&_[data-slot=popover-trigger]]:border-input [&_[data-slot=select-trigger]]:h-8 [&_[data-slot=select-trigger]]:border-input";

type DataTableToolbarProps<TData> = React.ComponentProps<"div"> & {
  table: Table<TData>;
  /**
   * Primary view controls, such as status tabs. On phones they join the
   * scrollable primary strip that stays in view above the list.
   */
  leading?: React.ReactNode;
  /**
   * The list's text search. On wide screens it leads the actions, exactly
   * where a first child would sit; on phones it stays in view beside the
   * Filters button. Without it, a phone finds the caller's children, search
   * included, behind that button.
   */
  search?: React.ReactNode;
  /**
   * The list's secondary axes (Type, Direction). Wide screens show one
   * `FilterPill` each after the search; phones lay them flat as toggle chips
   * in the Filters sheet. Applied values show as removable chips under the
   * toolbar at every width.
   */
  filterGroups?: readonly FilterGroup[];
  /**
   * Groups whose control the caller renders itself, such as a Facility
   * picker passed as `children`. The toolbar adds no pill for them: it only
   * shows their applied values as removable chips, and counts them for the
   * phone Filters badge.
   */
  chipGroups?: readonly FilterGroup[];
  /**
   * Clears every filter group in one write, for the chips' Clear All. Without
   * it each group is cleared through its own `onSelectedChange`.
   */
  onClearAllFilters?: () => void;
  /**
   * How many rows the current narrowing matches, for the phone sheet's
   * "Show 12 Results" button. Without it the button reads "Show Results".
   */
  resultCount?: number;
  /**
   * How many secondary narrowings are set behind the phone Filters button,
   * shown as its badge. Count only what the sheet holds: not the search, not
   * the primary controls. Defaults to the clearable column filters plus the
   * applied filter-group values.
   */
  activeFilterCount?: number;
  /**
   * Primary controls the page shows outside the toolbar on wide screens, such
   * as direction or heading tabs. On phones they join the primary strip, and
   * the page stops rendering them itself (see `useIsPhoneWidth`).
   */
  phonePrimary?: React.ReactNode;
  /**
   * Secondary controls the page shows outside the toolbar on wide screens,
   * such as a date range. On phones they open in the Filters sheet, and the
   * page stops rendering them itself (see `useIsPhoneWidth`).
   */
  phoneFilters?: React.ReactNode;
  /**
   * A view control, such as an Active/Archived `FilterPill`, kept on the
   * toolbar row at the right edge, immediately before the Columns menu. On
   * phones, which drop the Columns menu, it joins the primary strip so it
   * stays in view.
   */
  trailing?: React.ReactNode;
};

/**
 * The basic DataTable toolbar. On wide screens one row: the search, a
 * `FilterPill` per filter group, the caller's children (such as a "+ Filter"
 * menu), `leading` controls with the per-column filters and Reset, and at the
 * right edge the `trailing` control followed by the Columns menu. Applied filter-group values sit as chips under it.
 *
 * On phones the search stays in view beside one Filters button whose bottom
 * sheet holds every secondary control: the filter groups as toggle chips,
 * column filters, the caller's children, and `phoneFilters`; it closes on
 * "Show Results". The applied chips scroll in one row under it. A primary
 * strip (`leading` and `phonePrimary`) scrolls sideways above for pages that
 * still keep tabs in the toolbar; list pages put their view tabs above the
 * toolbar instead (`ListViewTabs`). The Columns menu is dropped there, since
 * phone cards hide nothing; `trailing` joins the primary strip there.
 */
export function DataTableToolbar<TData>({
  table,
  children,
  leading,
  search,
  filterGroups = NO_FILTER_GROUPS,
  chipGroups = NO_FILTER_GROUPS,
  onClearAllFilters,
  resultCount,
  activeFilterCount,
  phonePrimary,
  phoneFilters,
  trailing,
  className,
  ...props
}: DataTableToolbarProps<TData>) {
  const isPhoneWidth = useIsPhoneWidth();
  const columns = React.useMemo(() => table.getAllColumns().filter((column) => column.getCanFilter()), [table]);
  const chips = (
    <AppliedFilterChips
      groups={[...filterGroups, ...chipGroups]}
      {...(onClearAllFilters ? { onClearAll: onClearAllFilters } : {})}
    />
  );

  if (isPhoneWidth) {
    return (
      <div
        role="toolbar"
        aria-orientation="horizontal"
        className={cn("flex w-full min-w-0 flex-col gap-2 p-1", CONTROL_SIZING, className)}
        {...props}
      >
        <DataTablePhoneToolbarControls
          table={table}
          columns={columns}
          search={search}
          filterGroups={filterGroups}
          chipGroups={chipGroups}
          phoneFilters={phoneFilters}
          phonePrimary={phonePrimary}
          leading={leading}
          trailing={trailing}
          resultCount={resultCount}
          activeFilterCount={activeFilterCount}
        >
          {children}
        </DataTablePhoneToolbarControls>
        {chips}
      </div>
    );
  }

  const hasActions = isRendered(search) || filterGroups.length > 0 || React.Children.count(children) > 0;
  return (
    <div
      role="toolbar"
      aria-orientation="horizontal"
      className={cn("flex w-full min-w-0 flex-col gap-2 p-1", CONTROL_SIZING, className)}
      {...props}
    >
      <div data-slot="data-table-toolbar-row" className="flex w-full min-w-0 flex-wrap items-center gap-2">
        {hasActions ? (
          <div data-slot="data-table-toolbar-actions" className="flex min-w-0 flex-wrap items-center gap-2">
            {search}
            {filterGroups.map(({ id, ...group }) => (
              <FilterPill key={id} {...group} />
            ))}
            {children}
          </div>
        ) : null}
        <div data-slot="data-table-toolbar-filters" className="flex min-w-0 flex-wrap items-center gap-2 empty:hidden">
          {leading}
          <DataTableToolbarFilters table={table} columns={columns} />
        </div>
        <div data-slot="data-table-toolbar-columns" className="ml-auto flex items-center gap-2 self-start empty:hidden">
          {trailing}
          <DataTableColumnsMenu table={table} />
        </div>
      </div>
      {chips}
    </div>
  );
}

const NO_FILTER_GROUPS: readonly FilterGroup[] = [];

/**
 * The page's primary tabs on a phone. Each group keeps its buttons on one
 * line and takes a line of its own when two do not fit, so every tab stays in
 * view; a group wider than the screen scrolls by itself.
 */
function DataTablePrimaryStrip({ children }: { readonly children: React.ReactNode }) {
  return (
    <div
      data-slot="data-table-toolbar-primary"
      className="flex min-w-0 flex-wrap items-center gap-2 [&>*]:max-w-full [&>*]:shrink-0 [&>*]:overflow-x-auto [&>*]:[scrollbar-width:none]"
    >
      {children}
    </div>
  );
}

function DataTableFiltersSheet<TData>({
  table,
  columns,
  filterGroups,
  phoneFilters,
  resultCount,
  activeFilterCount,
  children,
}: {
  readonly table: Table<TData>;
  readonly columns: readonly Column<TData>[];
  readonly filterGroups: readonly FilterGroup[];
  readonly phoneFilters: React.ReactNode;
  readonly resultCount: number | undefined;
  readonly activeFilterCount: number;
  readonly children: React.ReactNode;
}) {
  const t = useDataTableCopy();
  const hasActions = React.Children.count(children) > 0;
  const hasControls =
    hasActions ||
    filterGroups.length > 0 ||
    isRendered(phoneFilters) ||
    columns.some((column) => column.columnDef.meta?.variant !== undefined);
  if (!hasControls) return null;

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          aria-label={activeFilterCount > 0 ? t("dataTable.action.filtersApplied", {}, activeFilterCount) : undefined}
        >
          <ListFilter aria-hidden="true" />
          {t("dataTable.action.filters")}
          {activeFilterCount > 0 ? (
            <Badge
              variant="secondary"
              className="h-[18.24px] rounded-[3.2px] px-[5.12px] font-mono font-normal text-[10.4px]"
            >
              <FormattedInteger value={activeFilterCount} />
            </Badge>
          ) : null}
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" aria-describedby={undefined} className="max-h-[85dvh] gap-0">
        <SheetHeader>
          <SheetTitle>{t("dataTable.filter.heading.active")}</SheetTitle>
        </SheetHeader>
        <div
          data-slot="data-table-filters-sheet"
          className="flex min-h-0 flex-col items-start gap-3 overflow-y-auto px-4 pb-1"
        >
          {filterGroups.map((group) => (
            <FilterGroupToggles key={group.id} group={group} />
          ))}
          {phoneFilters}
          <div className="flex w-full flex-wrap items-center gap-2 empty:hidden">
            <DataTableToolbarFilters table={table} columns={columns} />
          </div>
          {hasActions ? <div className="flex w-full min-w-0 flex-wrap items-center gap-2">{children}</div> : null}
        </div>
        <SheetFooter>
          <SheetClose asChild>
            <Button type="button">
              {resultCount === undefined
                ? t("dataTable.action.showResults")
                : t("dataTable.action.showCountResults", {}, resultCount)}
            </Button>
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function DataTableToolbarFilters<TData>({
  table,
  columns,
}: {
  readonly table: Table<TData>;
  readonly columns: readonly Column<TData>[];
}) {
  const t = useDataTableCopy();
  return (
    <>
      {columns.map((column) => (
        <DataTableToolbarFilter key={column.id} column={column} />
      ))}
      {hasClearableColumnFilters(table) && (
        <Button
          type="button"
          aria-label={t("dataTable.action.resetFilters")}
          variant="outline"
          size="sm"
          className="border-input border-dashed"
          onClick={() => {
            clearClearableColumnFilters(table);
          }}
        >
          <X />
          {t("dataTable.action.reset")}
        </Button>
      )}
    </>
  );
}

function isRendered(node: React.ReactNode): boolean {
  return node !== undefined && node !== null && typeof node !== "boolean";
}

function DataTablePhoneToolbarControls<TData>({
  table,
  columns,
  search,
  filterGroups,
  chipGroups,
  phoneFilters,
  phonePrimary,
  leading,
  trailing,
  resultCount,
  activeFilterCount,
  children,
}: {
  table: Table<TData>;
  columns: readonly Column<TData>[];
  search: React.ReactNode;
  filterGroups: readonly FilterGroup[];
  chipGroups: readonly FilterGroup[];
  phoneFilters: React.ReactNode;
  phonePrimary: React.ReactNode;
  leading: React.ReactNode;
  trailing: React.ReactNode;
  resultCount: number | undefined;
  activeFilterCount: number | undefined;
  children: React.ReactNode;
}) {
  const hasPrimary = [leading, phonePrimary, trailing].some(isRendered);
  return (
    <>
      {hasPrimary ? (
        <DataTablePrimaryStrip>
          {phonePrimary}
          {leading}
          {trailing}
        </DataTablePrimaryStrip>
      ) : null}
      <div className="flex min-w-0 items-center gap-2 empty:hidden">
        {isRendered(search) ? (
          <div data-slot="data-table-toolbar-search" className="flex min-w-0 flex-1 items-center">
            {search}
          </div>
        ) : null}
        <DataTableFiltersSheet
          table={table}
          columns={columns}
          filterGroups={filterGroups}
          phoneFilters={phoneFilters}
          resultCount={resultCount}
          activeFilterCount={
            activeFilterCount ??
            countClearableColumnFilters(table) + countAppliedFilterValues([...filterGroups, ...chipGroups])
          }
        >
          {children}
        </DataTableFiltersSheet>
      </div>
    </>
  );
}
