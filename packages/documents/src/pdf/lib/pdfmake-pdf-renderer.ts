import pdfmake from "pdfmake";
import type {
  PdfmakeDefinition,
  PdfRenderer,
  PdfTextMetrics,
} from "./pdf-renderer.js";

// The standard 14 PDF fonts — built into every PDF viewer, no font files
// shipped. Access policies locked down: a definition is data, not a
// capability — it can never read the filesystem or fetch URLs.
let configured = false;
function configure(): void {
  if (configured) return;
  pdfmake.addFonts({
    Helvetica: {
      normal: "Helvetica",
      bold: "Helvetica-Bold",
      italics: "Helvetica-Oblique",
      bolditalics: "Helvetica-BoldOblique",
    },
  });
  // Standard-font names route through the local policy too — allow exactly
  // those five identifiers; anything path-like (real file access) is denied.
  const standardFonts = new Set([
    "Helvetica",
    "Helvetica-Bold",
    "Helvetica-Oblique",
    "Helvetica-BoldOblique",
  ]);
  pdfmake.setLocalAccessPolicy((path) => standardFonts.has(path));
  pdfmake.setUrlAccessPolicy(() => false);
  configured = true;
}

export class PdfmakePdfRenderer implements PdfRenderer {
  #metrics: Promise<PdfTextMetrics> | undefined;

  constructor() {
    configure();
  }

  async render(definition: PdfmakeDefinition): Promise<Uint8Array> {
    const buffer = await pdfmake
      .createPdf({ defaultStyle: { font: "Helvetica" }, ...definition })
      .getBuffer();
    return new Uint8Array(buffer);
  }

  textMetrics(): Promise<PdfTextMetrics> {
    this.#metrics ??= this.#loadTextMetrics().catch((error: unknown) => {
      this.#metrics = undefined;
      throw error;
    });
    return this.#metrics;
  }

  async #loadTextMetrics(): Promise<PdfTextMetrics> {
    const document = await pdfmake
      .createPdf({ content: [], defaultStyle: { font: "Helvetica" } })
      .getStream();
    try {
      document.font("Helvetica").fontSize(1);
      const regular = readHelveticaFont(document);
      // Bold and regular share a line height; only the glyph advances differ.
      const lineHeight = document.currentLineHeight(false);
      const bold = readHelveticaFont(document.font("Helvetica-Bold"));

      await new Promise<void>((resolve, reject) => {
        document.once("end", resolve);
        document.once("error", reject);
        document.resume();
        document.end();
      });

      return createTextMetrics({ regular, bold }, lineHeight);
    } finally {
      document.destroy();
    }
  }
}

type HelveticaFont = {
  glyphsForString(text: string): string[];
  advancesForGlyphs(glyphs: string[]): number[];
};

function readHelveticaFont(document: PDFKit.PDFDocument): HelveticaFont {
  // Reads the document's current font. PDFKit's StandardFont retains its
  // document. Only its independent AFM metrics contain the glyph widths and
  // kerning needed after stream disposal.
  if (!("_font" in document)) throw new Error("Helvetica metrics unavailable");
  const standardFont: unknown = document._font;
  if (
    typeof standardFont !== "object" ||
    standardFont === null ||
    !("font" in standardFont) ||
    !isHelveticaFont(standardFont.font)
  ) {
    throw new Error("Helvetica metrics unavailable");
  }
  return standardFont.font;
}

function isHelveticaFont(value: unknown): value is HelveticaFont {
  return (
    typeof value === "object" &&
    value !== null &&
    "glyphsForString" in value &&
    typeof value.glyphsForString === "function" &&
    "advancesForGlyphs" in value &&
    typeof value.advancesForGlyphs === "function"
  );
}

function createTextMetrics(
  fonts: { regular: HelveticaFont; bold: HelveticaFont },
  lineHeight: number,
): PdfTextMetrics {
  return {
    width: (text, fontSizePt, bold = false) => {
      const font = bold ? fonts.bold : fonts.regular;
      const advances = font.advancesForGlyphs(font.glyphsForString(text));
      const width = advances.reduce((total, advance) => total + advance, 0);
      return (width * fontSizePt) / 1000;
    },
    lineHeight: (fontSizePt) => lineHeight * fontSizePt,
  };
}
