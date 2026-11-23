import type * as PdfmakeNamespace from "pdfmake";
import { loadOptionalPeer } from "../../optional-peer.js";
import type {
  PdfmakeDefinition,
  PdfRenderer,
  PdfTextMetrics,
} from "./pdf-renderer.js";

type PdfmakeModule = typeof PdfmakeNamespace;

// The standard 14 PDF fonts — built into every PDF viewer, no font files
// shipped. Access policies locked down: a definition is data, not a
// capability — it can never read the filesystem or fetch URLs.
const configuredInstances = new WeakSet<object>();

function configure(pdfmake: PdfmakeModule): void {
  if (configuredInstances.has(pdfmake)) return;
  pdfmake.addFonts({
    Helvetica: {
      normal: "Helvetica",
      bold: "Helvetica-Bold",
      italics: "Helvetica-Oblique",
      bolditalics: "Helvetica-BoldOblique",
    },
  });
  // Standard-font names route through the local policy too — allow exactly
  // those four identifiers; anything path-like (real file access) is denied.
  const standardFonts = new Set([
    "Helvetica",
    "Helvetica-Bold",
    "Helvetica-Oblique",
    "Helvetica-BoldOblique",
  ]);
  pdfmake.setLocalAccessPolicy((path) => standardFonts.has(path));
  pdfmake.setUrlAccessPolicy(() => false);
  configuredInstances.add(pdfmake);
}

export async function loadPdfmake(
  load: () => Promise<unknown> = () => import("pdfmake"),
): Promise<PdfmakeModule> {
  const loaded = await loadOptionalPeer(
    "@dads-framework/documents/pdf",
    "pdfmake",
    load,
  );
  const pdfmake = unwrapPdfmake(loaded);
  configure(pdfmake);
  return pdfmake;
}

function hasPdfmakeCore(value: object): boolean {
  return (
    "createPdf" in value &&
    typeof value.createPdf === "function" &&
    "addFonts" in value &&
    typeof value.addFonts === "function"
  );
}

function hasPdfmakePolicies(value: object): boolean {
  return (
    "setLocalAccessPolicy" in value &&
    typeof value.setLocalAccessPolicy === "function" &&
    "setUrlAccessPolicy" in value &&
    typeof value.setUrlAccessPolicy === "function"
  );
}

function isPdfmakeApi(value: unknown): value is PdfmakeModule {
  return (
    typeof value === "object" &&
    value !== null &&
    hasPdfmakeCore(value) &&
    hasPdfmakePolicies(value)
  );
}

function unwrapPdfmake(loaded: unknown): PdfmakeModule {
  if (
    typeof loaded === "object" &&
    loaded !== null &&
    "default" in loaded &&
    isPdfmakeApi(loaded.default)
  ) {
    return loaded.default;
  }
  if (isPdfmakeApi(loaded)) {
    return loaded;
  }
  throw new Error("pdfmake did not export the expected API");
}

export class PdfmakePdfRenderer implements PdfRenderer {
  #metrics: Promise<PdfTextMetrics> | undefined;

  async render(definition: PdfmakeDefinition): Promise<Uint8Array> {
    const pdfmake = await loadPdfmake();
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
    const pdfmake = await loadPdfmake();
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
