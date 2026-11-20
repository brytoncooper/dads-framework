/**
 * What: an edge counts as hiding content only while there is more to scroll
 * toward it — the left once scrolled from the start, the right until the end.
 * Why: a fade that lingers at the end of a table, or appears when nothing
 * overflows, teaches readers to ignore the one cue that data is off-screen.
 */
import { describe, expect, it } from "vitest";

import { hiddenEdges } from "./horizontal-overflow-edges.js";

describe("hiddenEdges", () => {
  it("hides nothing when the content fits", () => {
    expect(
      hiddenEdges({ scrollLeft: 0, clientWidth: 600, scrollWidth: 600 }),
    ).toEqual({ left: false, right: false });
  });

  it("hides only the right edge at the start of a wide table", () => {
    expect(
      hiddenEdges({ scrollLeft: 0, clientWidth: 600, scrollWidth: 900 }),
    ).toEqual({ left: false, right: true });
  });

  it("hides both edges part way through", () => {
    expect(
      hiddenEdges({ scrollLeft: 200, clientWidth: 600, scrollWidth: 900 }),
    ).toEqual({ left: true, right: true });
  });

  it("allows sub-pixel slack at either end", () => {
    expect(
      hiddenEdges({ scrollLeft: 299.5, clientWidth: 600, scrollWidth: 900 }),
    ).toEqual({ left: true, right: false });
    expect(
      hiddenEdges({ scrollLeft: 0.5, clientWidth: 600, scrollWidth: 900 }),
    ).toEqual({ left: false, right: true });
  });
});
