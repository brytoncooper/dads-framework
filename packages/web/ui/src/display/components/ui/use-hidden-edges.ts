import * as React from "react";

import {
  hiddenEdges,
  NO_HIDDEN_EDGES,
  type HiddenEdges,
} from "./logic/horizontal-overflow-edges.js";

/** Hidden edges, plus how far pinned columns reach in from each side (px). */
export type ScrollerEdges = HiddenEdges & {
  readonly pinnedLeft: number;
  readonly pinnedRight: number;
};

const NO_EDGES: ScrollerEdges = {
  ...NO_HIDDEN_EDGES,
  pinnedLeft: 0,
  pinnedRight: 0,
};

/**
 * Which edges of the scroller behind `scrollerRef` hide content, and how wide
 * the columns pinned to each side really render (`data-pinned` header cells),
 * so an edge fade can start past them rather than over them.
 *
 * Re-measured on scroll and whenever the scroller or anything inside it
 * resizes, so the answer follows window resizes, loaded rows, and columns the
 * reader shows or hides. Without `ResizeObserver` it still follows scrolling.
 */
export function useHiddenEdges(
  scrollerRef: React.RefObject<HTMLElement | null>,
): ScrollerEdges {
  const [edges, setEdges] = React.useState<ScrollerEdges>(NO_EDGES);

  React.useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return undefined;

    const measure = () => {
      const next = { ...hiddenEdges(scroller), ...pinnedReach(scroller) };
      setEdges((current) => (sameEdges(current, next) ? current : next));
    };
    measure();

    scroller.addEventListener("scroll", measure, { passive: true });
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    resizeObserver?.observe(scroller);
    for (const child of scroller.children) {
      resizeObserver?.observe(child);
    }

    return () => {
      scroller.removeEventListener("scroll", measure);
      resizeObserver?.disconnect();
    };
  }, [scrollerRef]);

  return edges;
}

function pinnedReach(scroller: HTMLElement): {
  pinnedLeft: number;
  pinnedRight: number;
} {
  const frame = scroller.getBoundingClientRect();
  let pinnedLeft = 0;
  let pinnedRight = 0;
  const firstRow = scroller.querySelector("tr");
  if (firstRow === null) return { pinnedLeft, pinnedRight };
  for (const cell of firstRow.querySelectorAll<HTMLElement>(
    ':scope > [data-pinned="left"]',
  )) {
    pinnedLeft = Math.max(
      pinnedLeft,
      cell.getBoundingClientRect().right - frame.left,
    );
  }
  for (const cell of firstRow.querySelectorAll<HTMLElement>(
    ':scope > [data-pinned="right"]',
  )) {
    pinnedRight = Math.max(
      pinnedRight,
      frame.right - cell.getBoundingClientRect().left,
    );
  }
  return {
    pinnedLeft: Math.round(pinnedLeft),
    pinnedRight: Math.round(pinnedRight),
  };
}

function sameEdges(a: ScrollerEdges, b: ScrollerEdges): boolean {
  return (
    a.left === b.left &&
    a.right === b.right &&
    a.pinnedLeft === b.pinnedLeft &&
    a.pinnedRight === b.pinnedRight
  );
}
