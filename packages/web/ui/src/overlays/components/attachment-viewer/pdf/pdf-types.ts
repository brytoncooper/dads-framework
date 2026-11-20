import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

import type { EventBus } from "./pdfjs-viewer.js";

/** The part of a loaded pdf.js document that thumbnails and print read. */
export type PdfPageSource = Pick<PDFDocumentProxy, "numPages" | "getPage">;

/** The part of pdf.js's event bus the find bar talks to. */
export type PdfEventBus = Pick<EventBus, "on" | "off" | "dispatch">;
