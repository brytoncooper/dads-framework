import * as React from "react";

import { FormattedInteger } from "../../copy/index.js";
import { cn } from "../../elements/index.js";

/**
 * One view of a list, such as "Open" or "All". `count` is the caller's number
 * for a work-queue view (usually `meta.total` of a `perPage=1` query); leave it
 * out for views that are not queues and nothing is shown. `countTone: "critical"`
 * tints the badge destructive, active or not, for a queue that needs attention
 * (such as unscheduled drafts); leave it out for the default muted/primary badge.
 */
export type ListView<TValue extends string> = {
  readonly value: TValue;
  readonly label: string;
  readonly count?: number;
  readonly countTone?: "critical";
};

type ListViewTabsProps<TValue extends string> = {
  /** What the views divide, for assistive technology: "Order Status". */
  readonly label: string;
  readonly views: readonly ListView<TValue>[];
  readonly value: TValue;
  readonly onValueChange: (value: TValue) => void;
  /** The id of the list the views narrow, announced as what the tabs control. */
  readonly controls?: string;
  readonly className?: string;
};

/**
 * The one row of mutually exclusive views on a list page: underlined tabs
 * with the active one in the primary colour and bold, and a small count badge
 * on work-queue views (primary-tinted on the active tab). It sits above the
 * toolbar at every width.
 *
 * Arrow keys, Home, and End move between views and choose them (one tab stop,
 * roving focus). On a phone the row never wraps: it scrolls sideways, fades at
 * its trailing edge, and brings the active view into the middle.
 */
export function ListViewTabs<TValue extends string>({
  label,
  views,
  value,
  onValueChange,
  controls,
  className,
}: ListViewTabsProps<TValue>) {
  const tabRefs = React.useRef(new Map<TValue, HTMLButtonElement>());

  React.useLayoutEffect(() => {
    centreInRow(tabRefs.current.get(value) ?? null);
  }, [value]);

  function chooseByOffset(from: TValue, offset: number | "first" | "last") {
    const index = views.findIndex((view) => view.value === from);
    const nextIndex =
      offset === "first"
        ? 0
        : offset === "last"
          ? views.length - 1
          : (index + offset + views.length) % views.length;
    const next = views[nextIndex];
    if (next === undefined) return;
    onValueChange(next.value);
    tabRefs.current.get(next.value)?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent, from: TValue) {
    const offset = KEY_OFFSETS[event.key];
    if (offset === undefined) return;
    event.preventDefault();
    chooseByOffset(from, offset);
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      data-slot="list-view-tabs"
      className={cn(
        "flex min-w-0 gap-0.5 overflow-x-auto border-b border-border [scrollbar-width:none] max-md:pr-10 max-md:[mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)]",
        className,
      )}
    >
      {views.map((view) => {
        const isActive = view.value === value;
        return (
          <button
            key={view.value}
            ref={(element) => {
              if (element === null) tabRefs.current.delete(view.value);
              else tabRefs.current.set(view.value, element);
            }}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={isActive ? controls : undefined}
            tabIndex={isActive ? 0 : -1}
            data-slot="list-view-tab"
            data-state={isActive ? "active" : "inactive"}
            className={cn(
              "-mb-px inline-flex min-h-10 shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 text-sm font-medium whitespace-nowrap text-foreground outline-none transition-colors motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11",
              "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
              isActive
                ? "border-primary font-semibold text-foreground"
                : "hover:border-border",
            )}
            onClick={() => {
              onValueChange(view.value);
            }}
            onKeyDown={(event) => {
              onKeyDown(event, view.value);
            }}
          >
            {view.label}
            {view.count === undefined ? null : (
              <>
                {" "}
                <span
                  data-slot="list-view-count"
                  className={cn(
                    "rounded-full bg-muted px-1.5 text-xs font-medium text-foreground tabular-nums",
                    isActive && "bg-primary/10 text-link",
                    view.countTone === "critical" &&
                      "bg-destructive/10 text-destructive",
                  )}
                >
                  <FormattedInteger value={view.count} />
                </span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

const KEY_OFFSETS: Readonly<Record<string, number | "first" | "last">> = {
  ArrowRight: 1,
  ArrowLeft: -1,
  Home: "first",
  End: "last",
};

/**
 * Brings the active view to the middle of the row. Only the row scrolls, and
 * where every view fits this does nothing.
 */
function centreInRow(tab: HTMLButtonElement | null): void {
  const row = tab?.parentElement;
  if (!tab || !row) return;
  row.scrollLeft =
    tab.offsetLeft - row.offsetLeft - (row.clientWidth - tab.clientWidth) / 2;
}
