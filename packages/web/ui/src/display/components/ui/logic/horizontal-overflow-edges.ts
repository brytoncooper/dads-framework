/** The three scroll measurements that decide which edges hide content. */
export type HorizontalScrollMetrics = {
  readonly scrollLeft: number;
  readonly clientWidth: number;
  readonly scrollWidth: number;
};

/** Which edges of a horizontal scroller have content hidden past them. */
export type HiddenEdges = {
  readonly left: boolean;
  readonly right: boolean;
};

export const NO_HIDDEN_EDGES: HiddenEdges = { left: false, right: false };

/**
 * Sub-pixel layout leaves a fraction of a pixel unscrolled at either end, so
 * anything within this many pixels of an edge counts as scrolled to it.
 */
const END_TOLERANCE_PX = 1;

/**
 * Which edges of a horizontal scroller hide content: the left once the reader
 * has scrolled away from the start, the right until they reach the end.
 * Neither when nothing overflows.
 */
export function hiddenEdges(metrics: HorizontalScrollMetrics): HiddenEdges {
  const hiddenOnRight = metrics.scrollWidth - metrics.clientWidth - metrics.scrollLeft;
  return {
    left: metrics.scrollLeft > END_TOLERANCE_PX,
    right: hiddenOnRight > END_TOLERANCE_PX,
  };
}
