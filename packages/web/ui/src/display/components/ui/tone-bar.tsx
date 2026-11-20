import * as React from "react";

import { cn } from "../../../elements/index.js";

import { STATUS_LAMP_CLASS, type StatusTone } from "./status-tone.js";

type ToneBarProps = Omit<React.ComponentProps<"div">, "children" | "role"> & {
  /** 0 to 100; values outside the range are clamped. */
  percent: number;
  tone: StatusTone;
  /** Accessible text such as "40% remaining". Required: the bar is role="img". */
  label: string;
};

function clampPercent(percent: number): number {
  if (Number.isNaN(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

/** A single-value progress bar whose fill color carries a semantic tone. */
export function ToneBar({
  percent,
  tone,
  label,
  className,
  ...props
}: ToneBarProps) {
  return (
    <div
      {...props}
      role="img"
      aria-label={label}
      data-slot="tone-bar"
      className={cn(
        "h-2 w-full overflow-hidden rounded-full bg-muted",
        className,
      )}
    >
      <div
        data-slot="tone-bar-fill"
        className={cn(
          "h-full rounded-full transition-[width] motion-reduce:transition-none",
          STATUS_LAMP_CLASS[tone],
        )}
        style={{ width: `${clampPercent(percent)}%` }}
      />
    </div>
  );
}
