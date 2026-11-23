import type * as React from "react";

import { cn } from "../../../elements/index.js";

type DataTableAdvancedToolbarProps = React.ComponentProps<"div">;

export function DataTableAdvancedToolbar({ children, className, ...props }: DataTableAdvancedToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-orientation="horizontal"
      className={cn(
        "flex w-full flex-col gap-2 p-1 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between",
        "[&_[data-slot=button]]:h-8 [&_[data-slot=button][data-variant=outline]]:border-input [&_[data-slot=popover-trigger]]:h-8 [&_[data-slot=popover-trigger]]:border-input [&_[data-slot=select-trigger]]:h-8 [&_[data-slot=select-trigger]]:border-input",
        className,
      )}
      {...props}
    >
      <div className="flex w-full min-w-0 flex-1 flex-wrap items-center gap-2 sm:w-auto">{children}</div>
    </div>
  );
}
