import { it } from "vitest";

import { runFixedPagePdfLaws } from "../../test-support/fixed-page-pdf-laws.js";
import { openReferencePagePdfWriter } from "../../test-support/reference-page-pdf-writer.js";
import { createFixedPagePdfRenderer } from "./pdfmake-fixed-page-renderer.js";

runFixedPagePdfLaws(
  () => createFixedPagePdfRenderer(),
  (name, run) => {
    it(`pdfmake writer ${name}`, async () => {
      await run();
    });
  },
);

runFixedPagePdfLaws(
  () => openReferencePagePdfWriter(),
  (name, run) => {
    it(`reference PDF writer ${name}`, async () => {
      await run();
    });
  },
);
