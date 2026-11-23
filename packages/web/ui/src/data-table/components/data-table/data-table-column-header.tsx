import type { Column } from "@tanstack/react-table";
import { ChevronDown, ChevronsUpDown, ChevronUp } from "lucide-react";

import { cn } from "../../../elements/index.js";

type DataTableColumnHeaderProps<TData, TValue> = React.ComponentProps<"button"> & {
  column: Column<TData, TValue>;
  label: string;
};

export function DataTableColumnHeader<TData, TValue>({
  column,
  label,
  className,
  onClick,
  ...props
}: DataTableColumnHeaderProps<TData, TValue>) {
  if (!column.getCanSort()) {
    return <div className={cn(className)}>{label}</div>;
  }

  const sortState = column.getIsSorted();
  return (
    <button
      {...props}
      type="button"
      className={cn(
        "-ml-1.5 flex h-8 items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring [&_svg]:size-4 [&_svg]:shrink-0",
        sortState === false ? "[&_svg]:text-muted-foreground" : "text-primary [&_svg]:text-primary",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) cycleColumnSort(column);
      }}
    >
      {label}
      {sortState === "desc" ? (
        <ChevronDown aria-hidden />
      ) : sortState === "asc" ? (
        <ChevronUp aria-hidden />
      ) : (
        <ChevronsUpDown aria-hidden />
      )}
    </button>
  );
}

function cycleColumnSort<TData, TValue>(column: Column<TData, TValue>): void {
  const current = column.getIsSorted();
  if (current === false) {
    column.toggleSorting(false);
    return;
  }
  if (current === "asc") {
    column.toggleSorting(true);
    return;
  }
  column.clearSorting();
}
