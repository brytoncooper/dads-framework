import { createRequire } from "node:module";
import path from "node:path";

import {
  PdfRasterizer,
  type RasterizedPdfPage,
  type RasterizeOptions,
} from "./pdf-rasterizer.js";

/** PDF points per inch. */
const POINTS_PER_INCH = 72;

/**
 * pdf.js (legacy Node build) draws each page onto an `@napi-rs/canvas`
 * canvas. Both load on first use: they are large, and the API bundle keeps
 * them external because pdf.js is ESM-only and the canvas is native.
 */
export class PdfjsPdfRasterizer extends PdfRasterizer {
  async rasterize(
    pdf: Uint8Array,
    options: RasterizeOptions,
  ): Promise<readonly RasterizedPdfPage[]> {
    const [pdfjs, canvasModule] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("@napi-rs/canvas"),
    ]);
    const document = await pdfjs.getDocument({
      // pdf.js takes ownership of (and detaches) the buffer it is given.
      data: new Uint8Array(pdf),
      standardFontDataUrl: standardFontDirectory(),
      isEvalSupported: false,
      verbosity: 0,
    }).promise;
    try {
      const pageCount = Math.min(document.numPages, options.maxPages);
      const pages: RasterizedPdfPage[] = [];
      for (let number = 1; number <= pageCount; number += 1) {
        const page = await document.getPage(number);
        const viewport = page.getViewport({
          scale: options.dpi / POINTS_PER_INCH,
        });
        const widthPx = Math.ceil(viewport.width);
        const heightPx = Math.ceil(viewport.height);
        const canvas = canvasModule.createCanvas(widthPx, heightPx);
        const context = canvas.getContext("2d");
        // Paper is white; an unpainted canvas is transparent.
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, widthPx, heightPx);
        await page.render({
          canvas: null,
          canvasContext: drawingContextFor(context),
          viewport,
        }).promise;
        page.cleanup();
        pages.push({
          png: new Uint8Array(await canvas.encode("png")),
          widthPx,
          heightPx,
        });
      }
      return pages;
    } finally {
      await document.destroy();
    }
  }
}

/**
 * pdf.js reads the 14 standard fonts (Helvetica, which ticket PDFs use
 * unembedded) from this directory; without it text would not draw.
 */
function standardFontDirectory(): string {
  const require = createRequire(thisModuleLocation());
  const packageJson = require.resolve("pdfjs-dist/package.json");
  return `${path.join(path.dirname(packageJson), "standard_fonts")}${path.sep}`;
}

/**
 * The API bundle is CommonJS, where esbuild leaves `import.meta` empty (so
 * `import.meta.url` is undefined and every preview failed); tests and other
 * ESM callers have no `__filename`.
 */
function thisModuleLocation(): string {
  return typeof __filename === "string" ? __filename : import.meta.url;
}

/**
 * The napi canvas's 2D context implements the drawing API pdf.js renders a
 * page with, but not the DOM's `CanvasRenderingContext2D` type (it has no
 * HTML canvas or focus rings). Checked at runtime, never cast.
 */
function drawingContextFor(context: unknown): CanvasRenderingContext2D {
  if (!isDrawingContext(context)) {
    throw new Error("@napi-rs/canvas returned no 2D drawing context");
  }
  return context;
}

function isDrawingContext(value: unknown): value is CanvasRenderingContext2D {
  return (
    typeof value === "object" &&
    value !== null &&
    "drawImage" in value &&
    "putImageData" in value &&
    "setTransform" in value
  );
}
