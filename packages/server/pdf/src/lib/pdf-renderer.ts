import type { TDocumentDefinitions } from "pdfmake/interfaces.js";

/** The input schema belongs to pdfmake. Keep both public type names. */
export type {
  TDocumentDefinitions as PdfmakeDefinition,
  TDocumentDefinitions as PdfDefinition,
} from "pdfmake/interfaces.js";

export type PdfTextMetrics = {
  /** Helvetica's width, or Helvetica Bold's when `bold` (Oblique matches upright). */
  width(text: string, fontSizePt: number, bold?: boolean): number;
  lineHeight(fontSizePt: number): number;
};

/** Renders pdfmake's document format to bytes and measures its built-in font. */
export abstract class PdfRenderer {
  abstract render(definition: TDocumentDefinitions): Promise<Uint8Array>;
  abstract textMetrics(): Promise<PdfTextMetrics>;
}
