/** Uniform-size pages with printable ASCII text in 12-point Helvetica. */
export type FixedPagePdf = {
  readonly width: number;
  readonly height: number;
  readonly pages: readonly (readonly string[])[];
};

export type FixedPagePdfRenderer = {
  render(document: FixedPagePdf): Promise<Uint8Array>;
};

export const PAGE_MARGIN = 18;
export const FONT_SIZE = 12;
export const LINE_HEIGHT = 16;

/** Reject content that would wrap or extend beyond its fixed page. */
export function requireFixedPagePdf(document: FixedPagePdf): void {
  const { width, height, pages } = document;
  const columns = Math.floor((width - 2 * PAGE_MARGIN) / FONT_SIZE);
  const rows = Math.floor((height - 2 * PAGE_MARGIN) / LINE_HEIGHT);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    columns < 1 ||
    rows < 1
  ) {
    throw new Error("PDF page size must leave room for at least one line");
  }
  if (pages.length === 0) throw new Error("A PDF needs at least one page");
  for (const page of pages) {
    if (page.length === 0 || page.length > rows) {
      throw new Error(
        "Each PDF page must have at least one line and fit its page height",
      );
    }
    if (page.some((line) => line.length > columns || !/^[ -~]+$/.test(line))) {
      throw new Error(
        "PDF lines must contain printable ASCII and fit their page width",
      );
    }
  }
}
