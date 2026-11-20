import { CalendarIcon } from "lucide-react";
import { resolveReaderTimeZone } from "@dads-framework/copy";
import { Button, cn } from "../../../elements/index.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../overlays/index.js";

import type { FilterOperator } from "../../lib/data-table-types.js";
import { formatDate, isSameDay, toTimestampText } from "../../lib/format.js";
import { DatePicker, DateRangePicker, dateRange } from "../ui/date-picker.js";
import type { FilterMenuInputProps } from "./data-table-filter-input-shared.js";

const DATE_FILTER_TIME_ZONE = resolveReaderTimeZone();
const DATE_FORMAT_OPTIONS = {
  timeZone: DATE_FILTER_TIME_ZONE,
  month: "short",
} satisfies Intl.DateTimeFormatOptions;

type DateInputLayout = "list" | "menu";

export function renderFilterDateInput<TData>(
  {
    filter,
    column,
    inputId,
    onFilterUpdate,
    showValueSelector,
    setShowValueSelector,
    copy,
    formatting,
  }: FilterMenuInputProps<TData>,
  layout: DateInputLayout,
) {
  const columnMeta = column.columnDef.meta;
  const label = (
    key:
      | "dataTable.filter.namedDate"
      | "dataTable.filter.selectNamedDate"
      | "dataTable.filter.selectNamedDateRange",
  ) =>
    layout === "list"
      ? copy(key, { columnLabel: String(columnMeta?.label) })
      : undefined;

  const inputListboxId = `${inputId}-listbox`;

  const timestamps = readDateFilterTimestamps(filter.value);
  const startDate = toDate(timestamps[0]);
  const endDate = toDate(timestamps[1]);

  const displayValue = formatDateLabel(
    startDate,
    endDate,
    showsDateRange(filter.operator, timestamps.length),
    formatting,
    copy,
    layout,
  );

  return (
    <Popover open={showValueSelector} onOpenChange={setShowValueSelector}>
      <PopoverTrigger asChild>
        <Button
          id={inputId}
          aria-controls={inputListboxId}
          aria-label={label("dataTable.filter.namedDate")}
          variant="outline"
          className={cn(
            layout === "list"
              ? "w-full justify-start rounded text-left font-normal"
              : "h-full rounded-none border px-1.5 font-normal dark:bg-input/30",
            !filter.value && "text-muted-foreground",
          )}
        >
          <CalendarIcon
            className={layout === "menu" ? "size-3.5" : undefined}
          />
          <span className="truncate">{displayValue}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent id={inputListboxId} align="start" className="w-auto p-0">
        {filter.operator === "isBetween" ? (
          <DateRangePicker
            aria-label={label("dataTable.filter.selectNamedDateRange")}
            autoFocus
            selected={dateRange(startDate, endDate)}
            onSelect={(range) => {
              onFilterUpdate(filter.filterId, {
                value: [
                  toTimestampText(range?.from),
                  toTimestampText(range?.to),
                ],
              });
            }}
          />
        ) : (
          <DatePicker
            aria-label={label("dataTable.filter.selectNamedDate")}
            autoFocus
            label={columnMeta?.label ?? copy("dataTable.date.label")}
            {...(startDate ? { selected: startDate } : {})}
            onSelect={(date) => {
              onFilterUpdate(filter.filterId, {
                value: toTimestampText(date),
              });
              if (layout === "list") setShowValueSelector(false);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function formatDateLabel<TData>(
  startDate: Date | undefined,
  endDate: Date | undefined,
  showsRange: boolean,
  formatting: FilterMenuInputProps<TData>["formatting"],
  copy: FilterMenuInputProps<TData>["copy"],
  layout: DateInputLayout,
) {
  if (showsRange && startDate && endDate && !isSameDay(startDate, endDate)) {
    return copy("dataTable.filter.dateRange", {
      from: formatDate(startDate, formatting, DATE_FORMAT_OPTIONS),
      to: formatDate(endDate, formatting, DATE_FORMAT_OPTIONS),
    });
  }
  if (startDate) return formatDate(startDate, formatting, DATE_FORMAT_OPTIONS);
  return copy(
    layout === "menu"
      ? "dataTable.filter.pickDate"
      : "dataTable.filter.pickADate",
  );
}

function showsDateRange(operator: FilterOperator, count: number): boolean {
  return operator === "isBetween" && count === 2;
}

function readDateFilterTimestamps(value: string | string[]): string[] {
  return (Array.isArray(value) ? value : [value, value]).filter(Boolean);
}

function toDate(timestamp: string | undefined): Date | undefined {
  return timestamp ? new Date(Number(timestamp)) : undefined;
}
