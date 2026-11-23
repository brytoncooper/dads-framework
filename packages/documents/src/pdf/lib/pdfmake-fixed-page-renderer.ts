import {
  FONT_SIZE,
  PAGE_MARGIN,
  requireFixedPagePdf,
  type FixedPagePdf,
  type FixedPagePdfRenderer,
} from "./fixed-page-pdf.js";
import { PdfmakePdfRenderer } from "./pdfmake-pdf-renderer.js";

class PdfmakeFixedPageRenderer implements FixedPagePdfRenderer {
  private readonly renderer = new PdfmakePdfRenderer();

  async render(document: FixedPagePdf): Promise<Uint8Array> {
    requireFixedPagePdf(document);
    return this.renderer.render({
      pageSize: { width: document.width, height: document.height },
      pageMargins: [PAGE_MARGIN, PAGE_MARGIN, PAGE_MARGIN, PAGE_MARGIN],
      content: document.pages.map((page, index) => ({
        stack: page.map((text) => ({
          text,
          fontSize: FONT_SIZE,
          noWrap: true,
          lineHeight: 1,
        })),
        ...(index === 0 ? {} : { pageBreak: "before" }),
      })),
    });
  }
}

export function createFixedPagePdfRenderer(): FixedPagePdfRenderer {
  return new PdfmakeFixedPageRenderer();
}
