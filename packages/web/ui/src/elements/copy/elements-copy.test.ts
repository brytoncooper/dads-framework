/**
 * What: primitive-owned loading labels live in the Elements catalog.
 * Why: accessibility copy must follow the reader's locale without making every
 * caller repeat the same default label.
 */
import { describe, expect, it } from "vitest";

import {
  assertCatalogParity,
  mergeCopy,
  translate,
} from "@dads-framework/copy";

import { elementsCopy } from "./elements-copy.js";

describe("elementsCopy", () => {
  it("owns the primitive's default accessibility labels", () => {
    expect(translate(elementsCopy, "en", "elements.loading.label")).toBe(
      "Loading",
    );
  });

  it("has every supported locale for every phrase", () => {
    const merged = mergeCopy([
      { file: "elements-copy.ts", entries: elementsCopy },
    ]);
    expect(() => {
      assertCatalogParity(merged);
    }).not.toThrow();
  });
});
