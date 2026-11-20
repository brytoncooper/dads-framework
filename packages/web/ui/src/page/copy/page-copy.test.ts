/**
 * What: page-owned attachment list labels live in one catalog.
 * Why: the open and download button names carry the file name, so screen
 * reader users can tell the buttons in a long list apart.
 */
import { describe, expect, it } from "vitest";

import {
  assertCatalogParity,
  mergeCopy,
  translate,
} from "@dads-framework/copy";

import { pageCopy } from "./page-copy.js";

describe("pageCopy", () => {
  it("names the open and download buttons after the file", () => {
    expect(
      translate(pageCopy, "en", "page.attachments.open", { name: "a.pdf" }),
    ).toBe("Open a.pdf");
    expect(
      translate(pageCopy, "en", "page.attachments.download", {
        name: "a.pdf",
      }),
    ).toBe("Download a.pdf");
  });

  it("has every supported locale for every phrase", () => {
    const merged = mergeCopy([{ file: "page-copy.ts", entries: pageCopy }]);
    expect(() => {
      assertCatalogParity(merged);
    }).not.toThrow();
  });
});
