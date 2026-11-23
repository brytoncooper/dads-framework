import type { Column } from "@tanstack/react-table";

import { cn } from "../../../elements/index.js";
import { Input } from "../../../forms/index.js";

import { useDataTableCopy } from "../../copy/data-table-copy.js";
import type { FilterVariant } from "../../lib/data-table-types.js";
import { toFilterText } from "../../lib/format.js";
import { DataTableDateFilter } from "./data-table-date-filter.js";
import { DataTableFacetedFilter } from "./data-table-faceted-filter.js";
import { DataTableSearchInput } from "./data-table-search-input.js";
import { DataTableSliderFilter } from "./data-table-slider-filter.js";

type DataTableToolbarFilterProps<TData> = {
  column: Column<TData>;
};

export function DataTableToolbarFilter<TData>({ column }: DataTableToolbarFilterProps<TData>) {
  const variant = column.columnDef.meta?.variant;
  if (!variant) return null;
  return renderColumnFilter(column, variant);
}

function renderColumnFilter<TData>(column: Column<TData>, variant: FilterVariant) {
  const title = readColumnFilterTitle(column);
  switch (variant) {
    case "text":
      return <DataTableTextFilter column={column} />;

    case "number":
      return <DataTableNumberFilter column={column} />;

    case "range":
      return <DataTableSliderFilter column={column} title={title} />;

    case "date":
    case "dateRange":
      return <DataTableDateFilter column={column} title={title} multiple={variant === "dateRange"} />;

    case "select":
    case "multiSelect":
      return <DataTableOptionsFilter column={column} title={title} />;

    case "boolean":
      return null;
  }
}

function DataTableNumberFilter<TData>({ column }: DataTableToolbarFilterProps<TData>) {
  const columnMeta = column.columnDef.meta;
  const unit = columnMeta?.unit;
  const placeholder = columnMeta?.placeholder ?? columnMeta?.label;

  return (
    <div className="relative">
      <Input
        size="sm"
        type="number"
        inputMode="numeric"
        placeholder={placeholder}
        value={toFilterText(column.getFilterValue())}
        onChange={(event) => {
          column.setFilterValue(event.target.value);
        }}
        className={cn("h-8 w-[120px]", unit && "pr-8")}
      />
      {unit && (
        <span className="absolute top-0 right-0 bottom-0 flex items-center rounded-r-md bg-accent px-2 text-muted-foreground text-sm">
          {unit}
        </span>
      )}
    </div>
  );
}

function DataTableTextFilter<TData>({ column }: DataTableToolbarFilterProps<TData>) {
  const t = useDataTableCopy();
  const columnMeta = column.columnDef.meta;
  return (
    <DataTableSearchInput
      size="sm"
      aria-label={t("dataTable.filter.searchNamed", {
        columnLabel: columnMeta?.label ?? column.id,
      })}
      placeholder={columnMeta?.placeholder ?? columnMeta?.label}
      value={toFilterText(column.getFilterValue())}
      onCommit={(term) => {
        column.setFilterValue(term);
      }}
      className="h-8 w-40 lg:w-56"
    />
  );
}

function DataTableOptionsFilter<TData>({ column, title }: DataTableToolbarFilterProps<TData> & { title: string }) {
  const columnMeta = column.columnDef.meta;
  return (
    <DataTableFacetedFilter
      column={column}
      title={title}
      options={columnMeta?.options ?? []}
      multiple={columnMeta?.variant === "multiSelect"}
      canClear={columnMeta?.canClearFilter !== false}
    />
  );
}

function readColumnFilterTitle<TData>(column: Column<TData>): string {
  return column.columnDef.meta?.label ?? column.id;
}
