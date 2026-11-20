import { describe, expect, it } from "vitest";

import { PdfjsPdfRasterizer } from "./pdfjs-pdf-rasterizer.js";
import { PdfmakePdfRenderer } from "./pdfmake-pdf-renderer.js";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A 3-inch-wide, two-page PDF with Helvetica text, from the real renderer. */
async function twoPageReceipt(): Promise<Uint8Array> {
  return new PdfmakePdfRenderer().render({
    pageSize: { width: 216, height: 144 },
    pageMargins: [10, 10, 10, 10],
    content: [
      { text: "TICKET 1042", fontSize: 18 },
      { text: "Second page", fontSize: 12, pageBreak: "before" },
    ],
  });
}

/** Share of the PNG's pixels that are dark, read back through the canvas. */
async function inkedShare(png: Uint8Array): Promise<number> {
  const { loadImage, createCanvas } = await import("@napi-rs/canvas");
  const image = await loadImage(Buffer.from(png));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  let inked = 0;
  for (let index = 0; index < data.length; index += 4) {
    if ((data[index] ?? 255) < 128) inked += 1;
  }
  return inked / (data.length / 4);
}

describe("PdfjsPdfRasterizer", () => {
  it("renders every page of a real PDF as a PNG at the asked resolution", async () => {
    const pages = await new PdfjsPdfRasterizer().rasterize(
      await twoPageReceipt(),
      { dpi: 144, maxPages: 10 },
    );

    expect(pages).toHaveLength(2);
    for (const page of pages) {
      expect([...page.png.slice(0, 8)]).toEqual(PNG_SIGNATURE);
      // 216pt x 144pt at 144 dpi is 2px per point.
      expect(page.widthPx).toBe(432);
      expect(page.heightPx).toBe(288);
    }
    // The text really drew: some dark pixels on a white page, not a blank one.
    const share = await inkedShare(pages[0]?.png ?? new Uint8Array());
    expect(share).toBeGreaterThan(0.002);
    expect(share).toBeLessThan(0.5);
  }, 30_000);

  it("stops at maxPages", async () => {
    const pages = await new PdfjsPdfRasterizer().rasterize(
      await twoPageReceipt(),
      { dpi: 72, maxPages: 1 },
    );

    expect(pages).toHaveLength(1);
  }, 30_000);
});
