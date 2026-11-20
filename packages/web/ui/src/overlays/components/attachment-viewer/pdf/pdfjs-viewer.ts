/**
 * The one way in to pdf.js's viewer classes. Import them from here, never
 * from `pdf_viewer.mjs` directly: the detector rule
 */

// The viewer reads pdf.js from `globalThis.pdfjsLib` when it loads, so pdf.js must load first.
import "pdfjs-dist/legacy/build/pdf.mjs";

export {
  EventBus,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
