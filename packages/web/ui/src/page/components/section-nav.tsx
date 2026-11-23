import { Slot } from "radix-ui";
import * as React from "react";

import { cn } from "../../elements/index.js";

type SectionNavProps = Omit<React.ComponentProps<"nav">, "aria-label"> & {
  /** What the sections are, for assistive technology: "Equipment", "Areas". */
  readonly label: string;
};

type SectionNavItemProps = React.ComponentProps<"button"> & {
  /** Render the feature's own link instead of a button; it receives the styling. */
  readonly asChild?: boolean;
  /** The section on screen now. */
  readonly current: boolean;
};

/**
 * The sections of one page, as tabs: down the side where there is room, along
 * the top as a scrolling strip where there is not.
 *
 * Both forms mark the current section three ways — a bar in the primary
 * colour, a tint, and weight — and keep the others at full reading contrast,
 * so every section looks like something to press and the one on screen is
 * never in doubt. The strip fades at its trailing edge while more sections
 * lie beyond it, and brings the current section to its middle.
 */
export function SectionNav({ label, className, children, ...props }: SectionNavProps) {
  return (
    <nav {...props} aria-label={label} data-slot="section-nav" className={cn("min-w-0", className)}>
      <ul
        className={cn(
          "flex overflow-x-auto border-b border-border [scrollbar-width:none] max-md:[mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)] max-md:pr-10",
          "md:flex-col md:gap-0.5 md:overflow-visible md:border-b-0 md:border-l",
        )}
      >
        {children}
      </ul>
    </nav>
  );
}

/** One section. A button by default; `asChild` for a feature-owned link. */
export function SectionNavItem({ asChild = false, current, className, ...props }: SectionNavItemProps) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <li ref={current ? centreInStrip : undefined} className="shrink-0">
      <Comp
        {...(asChild ? {} : { type: "button" })}
        {...props}
        aria-current={current ? (asChild ? "page" : "true") : undefined}
        data-slot="section-nav-item"
        className={cn(
          "-mb-px flex min-h-11 items-center justify-between gap-3 border-b-2 border-transparent px-3 text-left text-sm whitespace-nowrap text-foreground outline-none transition-colors motion-reduce:transition-none",
          "hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
          "md:mb-0 md:-ml-px md:min-h-9 md:w-full md:rounded-r-md md:border-b-0 md:border-l-2 md:py-2",
          current && "border-primary font-semibold text-foreground md:bg-primary/10 md:hover:bg-primary/10",
          className,
        )}
      />
    </li>
  );
}

/** How many things a section holds, set quietly after its name. */
export function SectionNavCount({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      {...props}
      data-slot="section-nav-count"
      className={cn("text-xs font-normal text-foreground tabular-nums", className)}
    />
  );
}

/**
 * Brings the current section to the middle of the strip. Only the strip
 * scrolls — the page itself is never moved — and down the side, where nothing
 * overflows, this does nothing.
 */
function centreInStrip(item: HTMLLIElement | null): void {
  const strip = item?.parentElement;
  if (!item || !strip) return;
  strip.scrollLeft = item.offsetLeft - strip.offsetLeft - (strip.clientWidth - item.clientWidth) / 2;
}
