import type { PdfRenderer } from "./pdf-renderer.js";
import { PdfmakePdfRenderer } from "./pdfmake-pdf-renderer.js";

/** Construct the pdfmake PDF renderer. */
export function createPdfRenderer(): PdfRenderer {
  return new PdfmakePdfRenderer();
}
