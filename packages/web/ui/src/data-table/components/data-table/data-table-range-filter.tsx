import type { Column } from "@tanstack/react-table";
import * as React from "react";

import { cn } from "../../../elements/index.js";
import { Input } from "../../../forms/index.js";

import { useDataTableCopy } from "../../copy/data-table-copy.js";
import type { ExtendedColumnFilter } from "../../lib/data-table-types.js";

type DataTableRangeFilterProps<TData> = React.ComponentProps<"div"> & {
  filter: ExtendedColumnFilter<TData>;
  column: Column<TData>;
  inputId: string;
  onFilterUpdate: (
    filterId: string,
    updates: Partial<Omit<ExtendedColumnFilter<TData>, "filterId">>,
  ) => void;
};

export function DataTableRangeFilter<TData>({
  filter,
  column,
  inputId,
  onFilterUpdate,
  className,
  ...props
}: DataTableRangeFilterProps<TData>) {
  const t = useDataTableCopy();
  const meta = column.columnDef.meta;

  const [min, max] = React.useMemo(() => {
    const range = column.columnDef.meta?.range;
    if (range) return range;

    const values = column.getFacetedMinMaxValues();
    if (!values) return [0, 100];

    return [values[0], values[1]];
  }, [column]);

  const readInputValue = React.useCallback(
    (value: string | number | undefined) => {
      if (value === undefined || value === "") return "";
      return typeof value === "number" ? value.toString() : value;
    },
    [],
  );

  const value = React.useMemo(() => {
    if (Array.isArray(filter.value)) return filter.value.map(readInputValue);
    return [readInputValue(filter.value), ""];
  }, [filter.value, readInputValue]);

  const onRangeValueChange = React.useCallback(
    (value: string, isMin?: boolean) => {
      const currentValues = Array.isArray(filter.value)
        ? filter.value
        : ["", ""];
      const otherValue = isMin
        ? (currentValues[1] ?? "")
        : (currentValues[0] ?? "");

      if (isRangeEndInBounds(value, otherValue, { min, max }, isMin === true)) {
        onFilterUpdate(filter.filterId, {
          value: isMin ? [value, otherValue] : [otherValue, value],
        });
      }
    },
    [filter.filterId, filter.value, min, max, onFilterUpdate],
  );

  return (
    <div
      data-slot="range"
      className={cn("flex w-full items-center gap-2", className)}
      {...props}
    >
      <Input
        size="sm"
        id={`${inputId}-min`}
        type="number"
        aria-label={t("dataTable.filter.namedMinimum", {
          columnLabel: String(meta?.label),
        })}
        aria-valuemin={min}
        aria-valuemax={max}
        data-slot="range-min"
        inputMode="numeric"
        placeholder={min.toString()}
        min={min}
        max={max}
        className="h-8 w-full rounded"
        defaultValue={value[0]}
        onChange={(event) => {
          onRangeValueChange(event.target.value, true);
        }}
      />
      <span className="sr-only shrink-0 text-muted-foreground">
        {t("dataTable.range.to")}
      </span>
      <Input
        size="sm"
        id={`${inputId}-max`}
        type="number"
        aria-label={t("dataTable.filter.namedMaximum", {
          columnLabel: String(meta?.label),
        })}
        aria-valuemin={min}
        aria-valuemax={max}
        data-slot="range-max"
        inputMode="numeric"
        placeholder={max.toString()}
        min={min}
        max={max}
        className="h-8 w-full rounded"
        defaultValue={value[1]}
        onChange={(event) => {
          onRangeValueChange(event.target.value);
        }}
      />
    </div>
  );
}

function isRangeEndInBounds(
  value: string,
  otherValue: string,
  bounds: { min: number; max: number },
  isMin: boolean,
): boolean {
  if (value === "") return true;

  const number = Number(value);
  const lowerBound = isMin ? bounds.min : Number(otherValue) || bounds.min;
  const upperBound = isMin ? Number(otherValue) || bounds.max : bounds.max;
  return number >= lowerBound && number <= upperBound;
}
