/**
 * What: the resolution, paper size, batching, and progress count of Print.
 * Why: a printed page must come out at true size and stay crisp, a long or
 * oversized document must not exhaust memory, and progress must never overshoot.
 */
import { describe, expect, it } from "vitest";

import {
  PDF_POINTS_PER_INCH,
  PRINT_MAX_PAGE_PIXELS,
  PRINT_TARGET_DPI,
  chunkPages,
  printPageSize,
  printRenderScale,
  printedPageCount,
} from "./pdf-print.js";

describe("printRenderScale", () => {
  it("scales a page to the target DPI when it fits the pixel budget", () => {
    expect(printRenderScale(612, 792)).toBeCloseTo(PRINT_TARGET_DPI / PDF_POINTS_PER_INCH, 10);
  });

  it("honours an explicit target DPI", () => {
    expect(printRenderScale(612, 792, { targetDpi: 72 })).toBeCloseTo(1, 10);
  });

  it("trims the scale of an oversized page so it lands on the pixel budget", () => {
    const widthPt = 5000;
    const heightPt = 4000;
    const scale = printRenderScale(widthPt, heightPt);
    const area = widthPt * scale * heightPt * scale;
    expect(area).toBeLessThanOrEqual(PRINT_MAX_PAGE_PIXELS + 1);
    expect(area).toBeCloseTo(PRINT_MAX_PAGE_PIXELS, 0);
    expect(scale).toBeLessThan(PRINT_TARGET_DPI / PDF_POINTS_PER_INCH);
  });

  it("never divides by a zero-sized page", () => {
    const scale = printRenderScale(0, 0);
    expect(Number.isFinite(scale)).toBe(true);
    expect(scale).toBeGreaterThan(0);
  });
});

describe("printPageSize", () => {
  it("converts point dimensions to inches at true size", () => {
    const size = printPageSize(612, 792);
    expect(size.widthIn).toBeCloseTo(8.5, 10);
    expect(size.heightIn).toBeCloseTo(11, 10);
  });

  it("falls back to one inch rather than a zero-sized sheet", () => {
    const size = printPageSize(0, 0);
    expect(size.widthIn).toBe(1);
    expect(size.heightIn).toBe(1);
  });
});

describe("chunkPages", () => {
  it("splits a page count into ordered 1-based batches", () => {
    expect(chunkPages(10, 4)).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10],
    ]);
  });

  it("covers every page exactly once", () => {
    expect(chunkPages(37, 5).flat()).toEqual(Array.from({ length: 37 }, (_unused, index) => index + 1));
  });

  it("returns no batches for an empty document", () => {
    expect(chunkPages(0)).toEqual([]);
  });

  it("never produces a zero-sized batch", () => {
    expect(chunkPages(3, 0)).toEqual([[1], [2], [3]]);
  });
});

describe("printedPageCount", () => {
  it("passes a count inside the range through", () => {
    expect(printedPageCount(3, 20)).toBe(3);
  });

  it("never reports more done than the total, or fewer than none", () => {
    expect(printedPageCount(25, 20)).toBe(20);
    expect(printedPageCount(-2, 20)).toBe(0);
    expect(printedPageCount(4, 0)).toBe(0);
  });
});
