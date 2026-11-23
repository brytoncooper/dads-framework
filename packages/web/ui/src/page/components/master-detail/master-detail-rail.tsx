import type * as React from "react";

import { cn } from "../../../elements/index.js";
import { ToggleGroup, ToggleGroupItem } from "../../../forms/index.js";
import { ChevronDown, ChevronUp } from "../../../icons/index.js";

import { usePageCopy } from "../../copy/page-copy.js";
import { railSortDirection, toggledNameSort } from "./logic/rail-list.js";

/**
 * The list rail's frame, top to bottom: an optional `header` (section title
 * and its New action), the `controls` (search, then filters, then the
 * Active / Archived switcher), the `sortHeader`, and the list itself, which
 * fills the remaining height and scrolls on its own. The controls wrap like
 * text: full-width controls (search, segmented filters) take a row to
 * themselves, while filter pills hug their content and share a row.
 */
export function MasterDetailRail({
  header,
  controls,
  sortHeader,
  children,
}: {
  readonly header?: React.ReactNode;
  readonly controls: React.ReactNode;
  readonly sortHeader?: React.ReactNode;
  /** Usually one `MasterDetailList`. */
  readonly children: React.ReactNode;
}) {
  return (
    <div data-slot="master-detail-rail" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {header}
      <div
        data-slot="master-detail-rail-controls"
        className="flex flex-wrap items-center gap-2 border-b border-border p-3"
      >
        {controls}
      </div>
      {sortHeader}
      {children}
    </div>
  );
}

/** The rail's title row: the section name and its actions (a New button). */
export function MasterDetailRailHeader({
  title,
  actions,
}: {
  readonly title: string;
  readonly actions?: React.ReactNode;
}) {
  return (
    <div
      data-slot="master-detail-rail-header"
      className="flex min-h-12 items-center justify-between gap-2 border-b border-border px-3 py-2"
    >
      <h2 className="min-w-0 truncate font-semibold text-base">{title}</h2>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * The sortable Name header above the rows. It reads and writes the list's URL
 * sort string (`name` / `-name`), starting ascending when the list is sorted
 * by another key. Its accessible name says what pressing it will do.
 */
export function MasterDetailSortHeader({
  sort,
  label,
  onSortChange,
}: {
  /** The list's current sort string, such as `name`, `-name` or `-createdAt`. */
  readonly sort: string;
  /** Visible header text; defaults to "Name". */
  readonly label?: string;
  readonly onSortChange: (sort: "name" | "-name") => void;
}) {
  const t = usePageCopy();
  const text = label ?? t("page.masterDetail.name");
  const direction = railSortDirection(sort, "name");
  const nextSort = toggledNameSort(sort);
  const nextLabel =
    nextSort === "name"
      ? t("page.masterDetail.sortAscending", { label: text })
      : t("page.masterDetail.sortDescending", { label: text });
  const Chevron = direction === "desc" ? ChevronDown : ChevronUp;
  return (
    <button
      type="button"
      data-slot="master-detail-sort-header"
      aria-label={nextLabel}
      onClick={() => {
        onSortChange(nextSort);
      }}
      className="flex min-h-9 w-full cursor-pointer items-center gap-1 border-b border-border px-3 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
    >
      {text}
      <Chevron aria-hidden className={cn("size-3.5", direction === null && "opacity-40")} />
    </button>
  );
}

/** One choice of a rail's segmented filter; `count` shows after the label, as in "Tag Needed (4)". */
export type MasterDetailFilterOption<TValue extends string> = {
  readonly value: TValue;
  readonly label: string;
  readonly count?: number;
};

/**
 * A full-width segmented control for the rail: the Active / Archived switcher
 * or an "All / Tag Needed" view. Exactly one option is always chosen.
 */
export function MasterDetailSegmentedFilter<TValue extends string>({
  label,
  options,
  value,
  onValueChange,
}: {
  /** What the options divide, for assistive technology: "Status". */
  readonly label: string;
  readonly options: readonly MasterDetailFilterOption<TValue>[];
  readonly value: TValue;
  readonly onValueChange: (value: TValue) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="primary"
      size="sm"
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        const chosen = options.find((option) => option.value === next);
        if (chosen) onValueChange(chosen.value);
      }}
      className="w-full"
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value} className="flex-1">
          {option.count === undefined ? option.label : `${option.label} (${option.count})`}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
