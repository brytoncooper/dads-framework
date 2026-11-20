import * as React from "react";

import { Input, Label } from "../../../forms/index.js";
import { useDataTableCopy } from "../../copy/data-table-copy.js";

/**
 * A start/end pair, either end open. Named to match the shape the upstream
 * kit imported from `react-day-picker`, which this repo does not ship.
 */
export type DateRange = {
  from?: Date;
  to?: Date;
};

/** A range with only the ends that are set; an unset end is left out. */
export function dateRange(
  from: Date | undefined,
  to: Date | undefined,
): DateRange {
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

/**
 * Pick one date.
 *
 * A native `<input type="date">` rather than a rendered month grid: the kit's
 * calendar came from `react-day-picker`, which is not a dependency of this
 * workspace. The browser's own picker keeps the popover behaviour, the
 * keyboard story, and the locale formatting without adding a vendor.
 */
export function DatePicker({
  selected,
  onSelect,
  label,
  autoFocus,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "onSelect" | "type" | "value"> & {
  selected?: Date;
  onSelect: (date: Date | undefined) => void;
  label?: string;
}) {
  const t = useDataTableCopy();
  const inputId = React.useId();
  const resolvedLabel = label ?? t("dataTable.date.label");

  return (
    <div className="flex flex-col gap-2 p-3">
      <Label htmlFor={inputId} className="text-muted-foreground text-xs">
        {resolvedLabel}
      </Label>
      <Input
        {...props}
        id={inputId}
        type="date"
        autoFocus={autoFocus}
        value={toDateInputValue(selected)}
        onChange={(event) => {
          onSelect(fromDateInputValue(event.target.value));
        }}
      />
    </div>
  );
}

/** Pick a start and an end date, either end optional. */
export function DateRangePicker({
  selected,
  onSelect,
  fromLabel,
  toLabel,
  autoFocus,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "onSelect" | "type" | "value"> & {
  selected?: DateRange;
  onSelect: (range: DateRange | undefined) => void;
  fromLabel?: string;
  toLabel?: string;
}) {
  const t = useDataTableCopy();
  const fromId = React.useId();
  const toId = React.useId();
  const resolvedFromLabel = fromLabel ?? t("dataTable.date.from");
  const resolvedToLabel = toLabel ?? t("dataTable.date.to");

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-col gap-2">
        <Label htmlFor={fromId} className="text-muted-foreground text-xs">
          {resolvedFromLabel}
        </Label>
        <Input
          {...props}
          id={fromId}
          type="date"
          autoFocus={autoFocus}
          value={toDateInputValue(selected?.from)}
          onChange={(event) => {
            onSelect(
              dateRange(fromDateInputValue(event.target.value), selected?.to),
            );
          }}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={toId} className="text-muted-foreground text-xs">
          {resolvedToLabel}
        </Label>
        <Input
          {...props}
          id={toId}
          type="date"
          value={toDateInputValue(selected?.to)}
          onChange={(event) => {
            onSelect(
              dateRange(selected?.from, fromDateInputValue(event.target.value)),
            );
          }}
        />
      </div>
    </div>
  );
}

/** `<input type="date">` speaks `YYYY-MM-DD` in the viewer's own timezone. */
function toDateInputValue(date: Date | undefined): string {
  if (!date || Number.isNaN(date.getTime())) return "";

  const year = date.getFullYear().toString().padStart(4, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function fromDateInputValue(value: string): Date | undefined {
  if (value === "") return undefined;

  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return undefined;
  }

  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
