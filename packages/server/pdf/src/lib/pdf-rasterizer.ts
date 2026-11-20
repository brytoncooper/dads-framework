/**
 * The page-image seam: a PDF's pages as PNGs, for a reader that cannot open
 * a PDF (an AI assistant reading a tool result). Rendering a page is the
 * adapter's business; callers pick only the resolution.
 */
export type RasterizedPdfPage = Readonly<{
  png: Uint8Array;
  widthPx: number;
  heightPx: number;
}>;

export type RasterizeOptions = Readonly<{
  /** Pixels per inch; 72 is one pixel per PDF point. */
  dpi: number;
  /** Pages past this are not rendered. */
  maxPages: number;
}>;

export abstract class PdfRasterizer {
  abstract rasterize(
    pdf: Uint8Array,
    options: RasterizeOptions,
  ): Promise<readonly RasterizedPdfPage[]>;
}
