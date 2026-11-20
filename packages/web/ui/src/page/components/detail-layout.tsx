import * as React from "react";

import { cn } from "../../elements/index.js";

/** Two-column detail body: main work (2/3) and reference facts (1/3) at lg+. */
export function DetailColumns({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      {...props}
      data-slot="detail-columns"
      className={cn(
        "grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] lg:items-start",
        className,
      )}
    />
  );
}

/** The primary column; place it before DetailAside so phones see it first. */
export function DetailMain({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      {...props}
      data-slot="detail-main"
      className={cn("flex min-w-0 flex-col gap-6", className)}
    />
  );
}

/** The secondary column for reference facts. */
export function DetailAside({
  className,
  ...props
}: React.ComponentProps<"aside">) {
  return (
    <aside
      {...props}
      data-slot="detail-aside"
      className={cn("flex min-w-0 flex-col gap-6", className)}
    />
  );
}
