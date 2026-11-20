/**
 * The arithmetic the Print button is driven by.
 *
 * pdf.js does not publish its print service, so printing draws every page to
 * an image in a hidden container and hands that to the browser's print
 * dialog (see `pdf/use-pdf-print.ts`). The parts worth testing are pure sums:
 * the scale each page is drawn at, the paper size it is laid out to, how the
 * pages are split so the loop can yield, and the progress count.
 */

/** A PDF unit is 1/72 inch, so a page's point size is also its size at scale 1. */
export const PDF_POINTS_PER_INCH = 72;

/** The print resolution: crisp on paper without drawing at the printer's full resolution. */
export const PRINT_TARGET_DPI = 150;

/**
 * The most device pixels one printed page may hold. A letter sheet at 150 DPI
 * is about 2.1 MP, so this only trims an unusually large sheet (a wide
 * drawing), so one page cannot allocate an unbounded bitmap.
 */
export const PRINT_MAX_PAGE_PIXELS = 5_000_000;

/** How many pages are drawn before the loop yields, so progress paints and Cancel is heard. */
export const PRINT_RENDER_BATCH_SIZE = 4;

export type PrintScaleOptions = {
  readonly targetDpi?: number;
  readonly maxPagePixels?: number;
};

/**
 * The scale a page is drawn at for print. The base scale puts the page at the
 * target DPI; a page that would pass the pixel budget is trimmed by the square
 * root of the overshoot, so it lands on the budget and keeps its shape.
 */
export function printRenderScale(
  widthPt: number,
  heightPt: number,
  options: PrintScaleOptions = {},
): number {
  const targetDpi = options.targetDpi ?? PRINT_TARGET_DPI;
  const maxPixels = options.maxPagePixels ?? PRINT_MAX_PAGE_PIXELS;
  const safeWidth = widthPt > 0 ? widthPt : 1;
  const safeHeight = heightPt > 0 ? heightPt : 1;

  const base = targetDpi / PDF_POINTS_PER_INCH;
  const area = safeWidth * base * safeHeight * base;
  if (area <= maxPixels) return base;
  return base * Math.sqrt(maxPixels / area);
}

export type PrintPageSize = {
  /** The page's physical size, in inches, so it prints at true size. */
  readonly widthIn: number;
  readonly heightIn: number;
};

/** The paper size a printed page is laid out to, from its point size. */
export function printPageSize(
  widthPt: number,
  heightPt: number,
): PrintPageSize {
  const safeWidth = widthPt > 0 ? widthPt : PDF_POINTS_PER_INCH;
  const safeHeight = heightPt > 0 ? heightPt : PDF_POINTS_PER_INCH;
  return {
    widthIn: safeWidth / PDF_POINTS_PER_INCH,
    heightIn: safeHeight / PDF_POINTS_PER_INCH,
  };
}

/** Splits a page count into ordered batches of 1-based page numbers. */
export function chunkPages(
  pageCount: number,
  batchSize: number = PRINT_RENDER_BATCH_SIZE,
): number[][] {
  const size = Math.max(1, Math.trunc(batchSize));
  const count = Math.max(0, Math.trunc(pageCount));
  const batches: number[][] = [];
  for (let start = 1; start <= count; start += size) {
    const batch: number[] = [];
    for (let page = start; page < start + size && page <= count; page += 1) {
      batch.push(page);
    }
    batches.push(batch);
  }
  return batches;
}

/** Pages drawn so far, held inside 0..total so the readout never overshoots. */
export function printedPageCount(completed: number, total: number): number {
  return Math.min(Math.max(0, Math.trunc(completed)), Math.max(0, total));
}
