import * as React from "react";

import { Badge, cn } from "../../../elements/index.js";

import { STATUS_LAMP_CLASS, type StatusTone } from "./status-tone.js";

export type { StatusTone } from "./status-tone.js";

const STATUS_BADGE_CLASS: Record<StatusTone, string> = {
  positive: "border-success/50 bg-success/10 text-foreground",
  neutral: "border-border bg-muted/50 text-muted-foreground",
  warning: "border-warning-edge bg-warning-wash text-foreground",
  critical: "border-destructive/50 bg-destructive/10 text-foreground",
  information: "border-info/50 bg-info/10 text-foreground",
};

type StatusBadgeProps = Omit<React.ComponentProps<typeof Badge>, "asChild" | "children" | "variant"> & {
  tone: StatusTone;
  children: React.ReactNode;
};

/** A visible status word paired with a decorative semantic lamp. */
export function StatusBadge({ tone, className, children, ...props }: StatusBadgeProps) {
  return (
    <Badge
      {...props}
      data-slot="status-badge"
      variant="outline"
      className={cn("gap-1.5 border font-normal", STATUS_BADGE_CLASS[tone], className)}
    >
      <StatusLamp tone={tone} data-slot="status-badge-lamp" />
      {children}
    </Badge>
  );
}

type StatusLampProps = Omit<React.ComponentProps<"span">, "children"> & {
  tone: StatusTone;
};

/** A decorative semantic dot; always pair it with a visible word. */
export function StatusLamp({ tone, className, ...props }: StatusLampProps) {
  return (
    <span
      data-slot="status-lamp"
      {...props}
      aria-hidden="true"
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_LAMP_CLASS[tone], className)}
    />
  );
}
