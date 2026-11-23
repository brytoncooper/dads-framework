import { cn } from "../../../elements/index.js";

const FADE_BASE =
  "pointer-events-none absolute inset-y-0 z-30 w-8 from-card to-transparent opacity-0 transition-opacity duration-150 data-[visible]:opacity-100 motion-reduce:transition-none";

/**
 * A soft fade over one edge of a table's scroller, shown only while content
 * lies past that edge. Decorative: it takes no space, no pointer, and no
 * accessible name; the scroller itself is what the reader moves. `inset` (px)
 * keeps it clear of columns pinned to that edge.
 */
export function TableEdgeFade({
  edge,
  visible,
  inset,
}: {
  readonly edge: "left" | "right";
  readonly visible: boolean;
  readonly inset: number;
}) {
  const style = edge === "left" ? { left: `${inset}px` } : { right: `${inset}px` };
  return (
    <div
      aria-hidden="true"
      data-slot="table-edge-fade"
      data-edge={edge}
      data-visible={visible ? "" : undefined}
      style={style}
      className={cn(FADE_BASE, edge === "left" ? "bg-linear-to-r" : "bg-linear-to-l")}
    />
  );
}
