import type { Column } from "@tanstack/react-table";
import { PlusCircle, XCircle } from "lucide-react";
import * as React from "react";

import { useLocaleFormatting } from "@dads-framework/copy";
import { Button, cn, Separator } from "../../../elements/index.js";
import { Input, Label, Slider } from "../../../forms/index.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../overlays/index.js";

import { useDataTableCopy } from "../../copy/data-table-copy.js";

type Range = {
  min: number;
  max: number;
};

type RangeValue = [number, number];

function getIsValidRange(value: unknown): value is RangeValue {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  );
}

function parseValuesAsNumbers(value: unknown): RangeValue | undefined {
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(
      (v) =>
        (typeof v === "string" || typeof v === "number") && !Number.isNaN(v),
    )
  ) {
    return [Number(value[0]), Number(value[1])];
  }

  return undefined;
}

type DataTableSliderFilterProps<TData> = {
  column: Column<TData>;
  title?: string;
};

export function DataTableSliderFilter<TData>({
  column,
  title,
}: DataTableSliderFilterProps<TData>) {
  const t = useDataTableCopy();
  const formatting = useLocaleFormatting();
  const id = React.useId();

  const columnFilterValue = parseValuesAsNumbers(column.getFilterValue());
  const clearLabel = title
    ? t("dataTable.action.clearNamedFilter", { columnLabel: title })
    : t("dataTable.action.clearFilter");

  const defaultRange = column.columnDef.meta?.range;
  const unit = column.columnDef.meta?.unit;

  const { min, max, step } = React.useMemo<Range & { step: number }>(() => {
    let minValue = 0;
    let maxValue = 100;

    if (defaultRange && getIsValidRange(defaultRange)) {
      [minValue, maxValue] = defaultRange;
    } else {
      const facetedMinMax = column.getFacetedMinMaxValues();
      if (facetedMinMax) {
        [minValue, maxValue] = facetedMinMax;
      }
    }

    const rangeSize = maxValue - minValue;
    const step =
      rangeSize <= 20
        ? 1
        : rangeSize <= 100
          ? Math.ceil(rangeSize / 20)
          : Math.ceil(rangeSize / 50);

    return { min: minValue, max: maxValue, step };
  }, [column, defaultRange]);

  const range = React.useMemo((): RangeValue => {
    return columnFilterValue ?? [min, max];
  }, [columnFilterValue, min, max]);

  const formatValue = React.useCallback(
    (value: number) => {
      return formatting.formatInteger(value);
    },
    [formatting],
  );

  const onFromInputChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const numValue = Number(event.target.value);
      if (!Number.isNaN(numValue) && numValue >= min && numValue <= range[1]) {
        column.setFilterValue([numValue, range[1]]);
      }
    },
    [column, min, range],
  );

  const onToInputChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const numValue = Number(event.target.value);
      if (!Number.isNaN(numValue) && numValue <= max && numValue >= range[0]) {
        column.setFilterValue([range[0], numValue]);
      }
    },
    [column, max, range],
  );

  const onSliderValueChange = React.useCallback(
    (value: number[]) => {
      if (getIsValidRange(value)) {
        column.setFilterValue(value);
      }
    },
    [column],
  );

  const onReset = React.useCallback(() => {
    column.setFilterValue(undefined);
  }, [column]);

  return (
    <div className="flex items-center gap-1">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-input border-dashed font-normal"
          >
            <PlusCircle />
            <span>{title}</span>
            <SliderRangeLabel
              value={columnFilterValue}
              unit={unit}
              formatValue={formatValue}
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="flex w-auto flex-col gap-4">
          <div className="flex flex-col gap-3">
            <p className="font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
              {title}
            </p>
            <div className="flex items-center gap-4">
              <Label htmlFor={`${id}-from`} className="sr-only">
                {t("dataTable.date.from")}
              </Label>
              <div className="relative">
                <Input
                  size="sm"
                  id={`${id}-from`}
                  type="number"
                  aria-valuemin={min}
                  aria-valuemax={max}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder={min.toString()}
                  min={min}
                  max={max}
                  value={range[0].toString()}
                  onChange={onFromInputChange}
                  className={cn("h-8 w-24", unit && "pr-8")}
                />
                {unit && (
                  <span className="absolute top-0 right-0 bottom-0 flex items-center rounded-r-md bg-accent px-2 text-muted-foreground text-sm">
                    {unit}
                  </span>
                )}
              </div>
              <Label htmlFor={`${id}-to`} className="sr-only">
                {t("dataTable.range.to")}
              </Label>
              <div className="relative">
                <Input
                  size="sm"
                  id={`${id}-to`}
                  type="number"
                  aria-valuemin={min}
                  aria-valuemax={max}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder={max.toString()}
                  min={min}
                  max={max}
                  value={range[1].toString()}
                  onChange={onToInputChange}
                  className={cn("h-8 w-24", unit && "pr-8")}
                />
                {unit && (
                  <span className="absolute top-0 right-0 bottom-0 flex items-center rounded-r-md bg-accent px-2 text-muted-foreground text-sm">
                    {unit}
                  </span>
                )}
              </div>
            </div>
            <Label htmlFor={`${id}-slider`} className="sr-only">
              {t("dataTable.filter.namedSlider", {
                columnLabel: title ?? "",
              })}
            </Label>
            <Slider
              id={`${id}-slider`}
              min={min}
              max={max}
              step={step}
              value={range}
              onValueChange={onSliderValueChange}
            />
          </div>
          <Button
            type="button"
            aria-label={clearLabel}
            variant="outline"
            onClick={onReset}
          >
            {t("dataTable.action.clear")}
          </Button>
        </PopoverContent>
      </Popover>
      {columnFilterValue && (
        <Button
          type="button"
          aria-label={clearLabel}
          variant="outline"
          size="icon-sm"
          className="border-input border-dashed"
          onClick={onReset}
        >
          <XCircle />
        </Button>
      )}
    </div>
  );
}

function SliderRangeLabel({
  value,
  unit,
  formatValue,
}: {
  value: RangeValue | undefined;
  unit: string | undefined;
  formatValue: (value: number) => string;
}) {
  if (!value) return null;
  return (
    <>
      <Separator
        orientation="vertical"
        className="mx-0.5 data-[orientation=vertical]:h-4"
      />
      {formatValue(value[0])} - {formatValue(value[1])}
      {unit ? ` ${unit}` : ""}
    </>
  );
}
