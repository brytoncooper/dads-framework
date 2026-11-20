import * as React from "react";

import { cn } from "../../../elements/index.js";

import { TableEdgeFade } from "./table-edge-fade.js";
import { useHiddenEdges } from "./use-hidden-edges.js";

const PINNED_HEAD = "data-[pinned]:z-20 data-[pinned]:bg-table-header";
const PINNED_CELL = "data-[pinned]:z-20 data-[pinned]:bg-card";
const STICKY_FIRST_EDGE =
  "first:sticky first:left-0 first:z-20 first:shadow-[inset_-4px_0_4px_-4px_var(--border)]";
const STICKY_FIRST_HEAD = `${STICKY_FIRST_EDGE} first:bg-table-header`;
const STICKY_FIRST_CELL = `${STICKY_FIRST_EDGE} first:bg-card`;

const StickyFirstColumnContext = React.createContext(false);

type TableProps = React.ComponentProps<"table"> & {
  /**
   * Keep the first cell of every row in view while the other columns scroll
   * sideways, on an opaque surface that still takes the row's hover and
   * selected wash. For hand-built tables; `DataTable` pins through TanStack.
   */
  stickyFirstColumn?: boolean;
  /**
   * Classes for the scrolling container. It scrolls sideways only; vertical
   * scrolling belongs to the page, so do not give it a max height.
   */
  containerClassName?: string;
  /**
   * Width in pixels of columns kept at the right edge that are not marked
   * `data-pinned` (cells marked so are measured). The right edge fade ends
   * just left of them instead of covering them.
   */
  trailingPinnedWidth?: number;
};

/**
 * A table that never hides a column for lack of width: the columns scroll
 * sideways inside their own container, and a soft fade over each edge shows
 * while more lies past it, starting past any `data-pinned` columns. Under
 * `stickyFirstColumn` the pinned column's own shadow marks the left edge, so
 * only the right edge fades.
 */
function Table({
  className,
  stickyFirstColumn = false,
  containerClassName,
  trailingPinnedWidth = 0,
  ...props
}: TableProps) {
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const hidden = useHiddenEdges(scrollerRef);

  return (
    <StickyFirstColumnContext.Provider value={stickyFirstColumn}>
      <div data-slot="table-frame" className="relative w-full min-w-0">
        <div
          ref={scrollerRef}
          data-slot="table-container"
          className={cn("relative w-full overflow-x-auto", containerClassName)}
        >
          <table
            data-slot="table"
            data-sticky-first-column={stickyFirstColumn ? "" : undefined}
            className={cn("w-full caption-bottom text-sm", className)}
            {...props}
          />
        </div>
        {stickyFirstColumn ? null : (
          <TableEdgeFade
            edge="left"
            visible={hidden.left}
            inset={hidden.pinnedLeft}
          />
        )}
        <TableEdgeFade
          edge="right"
          visible={hidden.right}
          inset={Math.max(trailingPinnedWidth, hidden.pinnedRight)}
        />
      </div>
    </StickyFirstColumnContext.Provider>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-table-header font-medium [&>tr]:last:border-b-0",
        className,
      )}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b hover:[&>td]:bg-table-row-hover has-aria-expanded:[&>td]:bg-table-row-hover data-[state=selected]:[&>td]:bg-table-row-selected [&>td]:transition-colors motion-reduce:transition-none motion-reduce:[&>td]:transition-none",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A header cell. A pinned one (`data-pinned`, or the first cell under
 * `stickyFirstColumn`) paints the header band so columns scroll beneath it.
 */
function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  const stickyFirstColumn = React.useContext(StickyFirstColumnContext);
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        PINNED_HEAD,
        stickyFirstColumn && STICKY_FIRST_HEAD,
        className,
      )}
      {...props}
    />
  );
}

/**
 * A body cell. A pinned one (`data-pinned`, or the first cell under
 * `stickyFirstColumn`) paints the card surface so columns scroll beneath it;
 * the row's hover and selected wash still win over that surface.
 */
function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  const stickyFirstColumn = React.useContext(StickyFirstColumnContext);
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "relative p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&_[role=checkbox]]:relative [&_[role=checkbox]]:z-10 [&_button]:relative [&_button]:z-10 [&>[role=checkbox]]:translate-y-[2px]",
        PINNED_CELL,
        stickyFirstColumn && STICKY_FIRST_CELL,
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
};
