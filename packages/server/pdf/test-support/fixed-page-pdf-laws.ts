import { deepEqual, equal, match, rejects } from "node:assert/strict";

import type { FixedPagePdfRenderer } from "../src/lib/fixed-page-pdf.js";

export function runFixedPagePdfLaws(
  open: () => FixedPagePdfRenderer,
  register: (name: string, law: () => Promise<void>) => void,
): void {
  register(
    "writes readable PDF bytes with exact page dimensions and text",
    async () => {
      const width = 288;
      const height = 216;
      const expected = [["Inventory (A)", "Bins \\ rows"], ["Second page"]];
      const bytes = await open().render({ width, height, pages: expected });
      match(new TextDecoder().decode(bytes.subarray(0, 8)), /^%PDF-/);

      const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const document = await getDocument({
        data: bytes,
        isEvalSupported: false,
        useSystemFonts: true,
        verbosity: 0,
      }).promise;
      try {
        equal(document.numPages, expected.length);
        for (const [index, lines] of expected.entries()) {
          const page = await document.getPage(index + 1);
          const { width: pageWidth, height: pageHeight } = page.getViewport({
            scale: 1,
          });
          deepEqual([pageWidth, pageHeight], [width, height]);
          const content = await page.getTextContent();
          deepEqual(
            content.items.flatMap((item) =>
              "str" in item && item.str !== "" ? [item.str] : [],
            ),
            lines,
          );
        }
      } finally {
        await document.destroy();
      }
    },
  );

  register("refuses text outside the fixed-page subset", async () => {
    await rejects(
      () => open().render({ width: 100, height: 100, pages: [["不可用"]] }),
      /printable ASCII/,
    );
  });
}
