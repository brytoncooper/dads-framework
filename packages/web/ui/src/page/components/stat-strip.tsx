import * as React from "react";

import { StatusLamp, type StatusTone } from "../../display/index.js";
import { cn } from "../../elements/index.js";

type StatStripVariant = "card" | "plain";

type StatStripProps = React.ComponentProps<"dl"> & {
  /**
   * "card": its own bordered white surface under the page header.
   * "plain": no outer surface, for use inside a DetailCard.
   */
  variant?: StatStripVariant;
};

type StatItemProps = Omit<React.ComponentProps<"div">, "title"> & {
  label: React.ReactNode;
  value: React.ReactNode;
  /** One short context line under the value, such as "of 1 hr". */
  hint?: React.ReactNode;
  /** Adds a lamp before the label; "critical" also colors the value. */
  tone?: StatusTone;
};

const STAT_STRIP_VARIANT_CLASS: Record<StatStripVariant, string> = {
  card: "gap-px overflow-hidden rounded-lg border bg-border shadow-xs",
  plain: "gap-x-6 gap-y-4",
};

const STAT_ITEM_VARIANT_CLASS: Record<StatStripVariant, string> = {
  card: "bg-card px-4 py-3",
  plain: "p-0",
};

const StatStripVariantContext = React.createContext<StatStripVariant>("card");

/** A responsive row of key numbers; features format every value and label. */
export function StatStrip({ variant = "card", className, ...props }: StatStripProps) {
  return (
    <StatStripVariantContext.Provider value={variant}>
      <dl
        {...props}
        role="group"
        data-slot="stat-strip"
        data-variant={variant}
        className={cn(
          "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]",
          STAT_STRIP_VARIANT_CLASS[variant],
          className,
        )}
      />
    </StatStripVariantContext.Provider>
  );
}

/** One labelled number inside a StatStrip. */
export function StatItem({ label, value, hint, tone, className, ...props }: StatItemProps) {
  const variant = React.useContext(StatStripVariantContext);
  const hasHint = React.Children.toArray(hint).length > 0;

  return (
    <div
      {...props}
      data-slot="stat-item"
      data-tone={tone}
      className={cn("min-w-0", STAT_ITEM_VARIANT_CLASS[variant], className)}
    >
      <dt className="flex items-center gap-1.5 text-sm text-muted-foreground">
        {tone ? <StatusLamp tone={tone} /> : null}
        {label}
      </dt>
      <dd
        className={cn(
          "mt-1 text-2xl font-semibold tracking-tight tabular-nums",
          tone === "critical" && "text-destructive",
        )}
      >
        {value}
      </dd>
      {hasHint ? <dd className="mt-0.5 text-xs text-muted-foreground">{hint}</dd> : null}
    </div>
  );
}
