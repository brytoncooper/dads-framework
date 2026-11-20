import type { Column } from "@tanstack/react-table";
import { CalendarIcon, XCircle } from "lucide-react";
import * as React from "react";

import {
  resolveReaderTimeZone,
  useLocaleFormatting,
} from "@dads-framework/copy";
import { Button, Separator } from "../../../elements/index.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../overlays/index.js";

import { useDataTableCopy } from "../../copy/data-table-copy.js";
import { formatDate, toTimestampText } from "../../lib/format.js";
import {
  DatePicker,
  type DateRange,
  DateRangePicker,
  dateRange,
} from "../ui/date-picker.js";

const DATE_FILTER_TIME_ZONE = resolveReaderTimeZone();

type DateSelection = Date[] | DateRange;

function getIsDateRange(value: DateSelection): value is DateRange {
  return typeof value === "object" && !Array.isArray(value);
}

/** A half-open range still counts as a filter, so either end is enough. */
function getHasEitherEnd(range: DateRange): boolean {
  return range.from !== undefined || range.to !== undefined;
}

function parseAsDate(timestamp: number | string | undefined): Date | undefined {
  if (!timestamp) return undefined;
  const numericTimestamp =
    typeof timestamp === "string" ? Number(timestamp) : timestamp;
  const date = new Date(numericTimestamp);
  return !Number.isNaN(date.getTime()) ? date : undefined;
}

function parseColumnFilterValue(value: unknown) {
  if (value === null || value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "number" || typeof item === "string") {
        return item;
      }
      return undefined;
    });
  }

  if (typeof value === "string" || typeof value === "number") {
    return [value];
  }

  return [];
}

type DataTableDateFilterProps<TData> = {
  column: Column<TData>;
  title?: string;
  multiple?: boolean;
};

export function DataTableDateFilter<TData>({
  column,
  title,
  multiple,
}: DataTableDateFilterProps<TData>) {
  const t = useDataTableCopy();
  const formatting = useLocaleFormatting();
  const columnFilterValue = column.getFilterValue();
  const clearLabel = title
    ? t("dataTable.action.clearNamedFilter", { columnLabel: title })
    : t("dataTable.action.clearFilter");

  const selectedDates = React.useMemo<DateSelection>(() => {
    if (!columnFilterValue) {
      return multiple ? {} : [];
    }

    if (multiple) {
      const timestamps = parseColumnFilterValue(columnFilterValue);
      return dateRange(parseAsDate(timestamps[0]), parseAsDate(timestamps[1]));
    }

    const timestamps = parseColumnFilterValue(columnFilterValue);
    const date = parseAsDate(timestamps[0]);
    return date ? [date] : [];
  }, [columnFilterValue, multiple]);

  const onSelectDate = React.useCallback(
    (date: Date | undefined) => {
      column.setFilterValue(date?.getTime());
    },
    [column],
  );

  const onSelectRange = React.useCallback(
    (range: DateRange | undefined) => {
      if (!range?.from && !range?.to) {
        column.setFilterValue(undefined);
        return;
      }

      column.setFilterValue([
        toTimestampText(range.from),
        toTimestampText(range.to),
      ]);
    },
    [column],
  );

  const onReset = React.useCallback(() => {
    column.setFilterValue(undefined);
  }, [column]);

  const hasValue = React.useMemo(() => {
    if (multiple) {
      if (!getIsDateRange(selectedDates)) return false;
      return getHasEitherEnd(selectedDates);
    }
    if (!Array.isArray(selectedDates)) return false;
    return selectedDates.length > 0;
  }, [multiple, selectedDates]);

  const formatDateRange = React.useCallback(
    (range: DateRange) => {
      if (!range.from && !range.to) return "";
      if (range.from && range.to) {
        return t("dataTable.filter.dateRange", {
          from: formatDate(range.from, formatting, {
            timeZone: DATE_FILTER_TIME_ZONE,
          }),
          to: formatDate(range.to, formatting, {
            timeZone: DATE_FILTER_TIME_ZONE,
          }),
        });
      }
      return formatDate(range.from ?? range.to, formatting, {
        timeZone: DATE_FILTER_TIME_ZONE,
      });
    },
    [formatting, t],
  );

  const label = React.useMemo(() => {
    if (multiple) {
      if (!getIsDateRange(selectedDates)) return null;

      const hasSelectedDates = getHasEitherEnd(selectedDates);
      const dateText = hasSelectedDates
        ? formatDateRange(selectedDates)
        : t("dataTable.filter.selectDateRange");

      return (
        <span className="flex items-center gap-2">
          <span>{title}</span>
          {hasSelectedDates && (
            <>
              <Separator
                orientation="vertical"
                className="mx-0.5 data-[orientation=vertical]:h-4"
              />
              <span>{dateText}</span>
            </>
          )}
        </span>
      );
    }

    if (getIsDateRange(selectedDates)) return null;

    const hasSelectedDate = selectedDates.length > 0;
    const dateText = hasSelectedDate
      ? formatDate(selectedDates[0], formatting, {
          timeZone: DATE_FILTER_TIME_ZONE,
        })
      : t("dataTable.filter.selectDate");

    return (
      <span className="flex items-center gap-2">
        <span>{title}</span>
        {hasSelectedDate && (
          <>
            <Separator
              orientation="vertical"
              className="mx-0.5 data-[orientation=vertical]:h-4"
            />
            <span>{dateText}</span>
          </>
        )}
      </span>
    );
  }, [selectedDates, multiple, formatDateRange, formatting, title, t]);

  const selectedRange = getIsDateRange(selectedDates)
    ? selectedDates
    : undefined;
  const selectedDate = Array.isArray(selectedDates)
    ? selectedDates[0]
    : undefined;

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
            <CalendarIcon />
            {label}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          {multiple ? (
            <DateRangePicker
              autoFocus
              {...(selectedRange ? { selected: selectedRange } : {})}
              onSelect={onSelectRange}
            />
          ) : (
            <DatePicker
              autoFocus
              label={title ?? t("dataTable.date.label")}
              {...(selectedDate ? { selected: selectedDate } : {})}
              onSelect={onSelectDate}
            />
          )}
        </PopoverContent>
      </Popover>
      {hasValue && (
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
