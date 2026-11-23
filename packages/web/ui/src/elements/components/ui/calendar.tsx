"use client";

import {
  DayPicker,
  type ClassNames,
  type CustomComponents,
  type Formatters,
  type PropsBase,
  type PropsSingle,
} from "@daypicker/react";
import { ChevronLeftIcon, ChevronRightIcon, ChevronsUpDownIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/utils.js";

const navButtonClassNames =
  "relative flex size-(--cell-size) items-center justify-center rounded-md border border-input bg-card text-foreground not-in-data-selected:hover:bg-accent disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

export const calendarClassNames = {
  button_next: navButtonClassNames,
  button_previous: navButtonClassNames,
  caption_label: "text-sm font-medium",
  day: "relative size-(--cell-size) p-0 text-center",
  day_button: cn(
    "flex size-(--cell-size) items-center justify-center rounded-md text-sm outline-none",
    "hover:bg-accent hover:text-accent-foreground",
    "in-data-selected:bg-primary in-data-selected:text-primary-foreground in-data-selected:hover:bg-primary",
    "in-data-disabled:pointer-events-none in-data-disabled:text-muted-foreground in-data-disabled:opacity-50",
    "in-data-outside:text-muted-foreground",
    "in-data-selected:in-data-outside:text-primary-foreground",
    "focus-visible:z-1 focus-visible:ring-[3px] focus-visible:ring-ring/50",
    "in-[.range-middle]:rounded-none in-[.range-end:not(.range-start)]:rounded-s-none in-[.range-start:not(.range-end)]:rounded-e-none",
    "in-[.range-middle]:in-data-selected:bg-accent in-[.range-middle]:in-data-selected:text-foreground",
  ),
  dropdown: "absolute inset-0 bg-popover opacity-0",
  dropdown_root:
    "relative h-8 rounded-md border border-input px-2.5 shadow-xs has-focus:border-ring has-focus:ring-[3px] has-focus:ring-ring/50",
  dropdowns: "flex h-(--cell-size) w-full items-center justify-center gap-1.5 text-sm",
  hidden: "invisible",
  month: "flex w-full flex-col gap-2",
  month_caption: "relative z-2 mx-(--cell-size) flex h-(--cell-size) items-center justify-center",
  month_grid: "w-full border-collapse",
  months: "relative flex flex-col gap-2",
  nav: "absolute top-0 z-1 flex w-full justify-between",
  outside: "text-muted-foreground",
  range_end: "range-end",
  range_middle: "range-middle",
  range_start: "range-start",
  today: "font-medium text-primary data-selected:text-primary-foreground",
  week: "mt-1 flex w-full",
  weekday: "flex-1 p-0 text-center text-xs font-medium text-muted-foreground",
  weekdays: "flex w-full",
  week_number: "size-(--cell-size) p-0 text-xs font-medium text-muted-foreground",
} satisfies Partial<ClassNames>;

export type CalendarProps = Omit<
  PropsBase & PropsSingle,
  "mode" | "required" | "className" | "classNames" | "components" | "formatters"
> & {
  readonly className?: string;
  readonly classNames?: Partial<ClassNames>;
  readonly components?: Partial<CustomComponents>;
  readonly formatters?: Partial<Formatters>;
};

export function Calendar({
  className,
  classNames,
  components,
  formatters,
  showOutsideDays = true,
  ...props
}: CalendarProps): React.ReactElement {
  return (
    <DayPicker
      {...props}
      mode="single"
      required={false}
      showOutsideDays={showOutsideDays}
      className={cn("w-fit p-3 [--cell-size:--spacing(8)]", className)}
      classNames={mergeClassNames(classNames)}
      components={{ Chevron: CalendarChevron, ...components }}
      {...(formatters === undefined ? {} : { formatters })}
      data-slot="calendar"
    />
  );
}

function mergeClassNames(classNames: Partial<ClassNames> = {}): Partial<ClassNames> {
  return {
    ...calendarClassNames,
    ...classNames,
    button_next: cn(calendarClassNames.button_next, classNames.button_next),
    button_previous: cn(calendarClassNames.button_previous, classNames.button_previous),
    caption_label: cn(calendarClassNames.caption_label, classNames.caption_label),
    day: cn(calendarClassNames.day, classNames.day),
    day_button: cn(calendarClassNames.day_button, classNames.day_button),
    dropdown: cn(calendarClassNames.dropdown, classNames.dropdown),
    dropdown_root: cn(calendarClassNames.dropdown_root, classNames.dropdown_root),
    dropdowns: cn(calendarClassNames.dropdowns, classNames.dropdowns),
    month: cn(calendarClassNames.month, classNames.month),
    month_caption: cn(calendarClassNames.month_caption, classNames.month_caption),
    month_grid: cn(calendarClassNames.month_grid, classNames.month_grid),
    months: cn(calendarClassNames.months, classNames.months),
    nav: cn(calendarClassNames.nav, classNames.nav),
    outside: cn(calendarClassNames.outside, classNames.outside),
    today: cn(calendarClassNames.today, classNames.today),
    week: cn(calendarClassNames.week, classNames.week),
    weekday: cn(calendarClassNames.weekday, classNames.weekday),
    weekdays: cn(calendarClassNames.weekdays, classNames.weekdays),
    week_number: cn(calendarClassNames.week_number, classNames.week_number),
  };
}

function CalendarChevron({
  className,
  orientation,
}: React.ComponentProps<CustomComponents["Chevron"]>): React.ReactElement {
  if (orientation === "left") {
    return <ChevronLeftIcon className={cn(className, "rtl:rotate-180")} aria-hidden="true" />;
  }
  if (orientation === "right") {
    return <ChevronRightIcon className={cn(className, "rtl:rotate-180")} aria-hidden="true" />;
  }
  return <ChevronsUpDownIcon className={className} aria-hidden="true" />;
}
