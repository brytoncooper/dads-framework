import * as React from "react";

import { cn } from "../../../elements/index.js";

import { Label } from "./label.js";

/** Two calendar days, `YYYY-MM-DD`; either may be blank while typing. */
type DateRange = { readonly start: string; readonly end: string };

type DateRangeFieldProps = {
  readonly label: string;
  /** Accessible names for the two inputs: "Start date", "End date". */
  readonly startLabel: string;
  readonly endLabel: string;
  /** The short word between the two days: "to". */
  readonly separator: string;
  readonly value: DateRange;
  readonly onChange: (value: DateRange) => void;
  readonly invalid?: boolean;
  /** The id of the message that explains an invalid range. */
  readonly errorId?: string;
  readonly disabled?: boolean;
  readonly className?: string;
};

/**
 * One labeled control holding a start and an end day: two native date
 * inputs inside a single border and focus ring. The end cannot be picked
 * before the start where the browser honours `min`/`max`; the caller still
 * refuses a reversed range typed by hand.
 */
function DateRangeField({
  label,
  startLabel,
  endLabel,
  separator,
  value,
  onChange,
  invalid = false,
  errorId,
  disabled = false,
  className,
}: DateRangeFieldProps) {
  const labelId = React.useId();
  const startId = React.useId();
  const day =
    "min-w-0 flex-1 bg-transparent text-base text-foreground outline-none disabled:cursor-not-allowed md:text-sm [&::-webkit-calendar-picker-indicator]:ml-1";

  return (
    <div data-slot="date-range-field" className={cn("flex min-w-0 flex-col gap-2", className)}>
      <Label id={labelId} htmlFor={startId}>
        {label}
      </Label>
      <div
        role="group"
        aria-labelledby={labelId}
        aria-invalid={invalid || undefined}
        aria-describedby={errorId}
        data-disabled={disabled || undefined}
        className={cn(
          "flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-card px-3 shadow-xs transition-[color,box-shadow] [@media(pointer:coarse)]:min-h-11 dark:bg-input/30 motion-reduce:transition-none",
          "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
          "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
          "data-[disabled]:opacity-50",
        )}
      >
        <input
          id={startId}
          type="date"
          aria-label={startLabel}
          aria-invalid={invalid || undefined}
          aria-describedby={errorId}
          disabled={disabled}
          value={value.start}
          max={value.end === "" ? undefined : value.end}
          onChange={(event) => {
            onChange({ ...value, start: event.target.value });
          }}
          className={cn(day, "max-sm:[&::-webkit-calendar-picker-indicator]:hidden")}
        />
        <span aria-hidden="true" className="shrink-0 text-sm text-foreground">
          {separator}
        </span>
        <input
          type="date"
          aria-label={endLabel}
          aria-invalid={invalid || undefined}
          aria-describedby={errorId}
          disabled={disabled}
          value={value.end}
          min={value.start === "" ? undefined : value.start}
          onChange={(event) => {
            onChange({ ...value, end: event.target.value });
          }}
          className={day}
        />
      </div>
    </div>
  );
}

export { DateRangeField, type DateRange, type DateRangeFieldProps };
