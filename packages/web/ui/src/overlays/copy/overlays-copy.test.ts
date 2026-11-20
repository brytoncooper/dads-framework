/**
 * What: overlay-owned close and command-palette defaults live in one catalog.
 * Why: hidden dialog descriptions and close labels are accessibility copy just
 * as much as visible button text.
 */
import { describe, expect, it } from "vitest";

import {
  assertCatalogParity,
  mergeCopy,
  translate,
} from "@dads-framework/copy";

import { overlaysCopy } from "./overlays-copy.js";

describe("overlaysCopy", () => {
  it("owns the shared overlay defaults", () => {
    expect(translate(overlaysCopy, "en", "overlays.action.close")).toBe(
      "Close",
    );
    expect(translate(overlaysCopy, "en", "overlays.commandPalette.title")).toBe(
      "Command Palette",
    );
    expect(
      translate(overlaysCopy, "en", "overlays.commandPalette.description"),
    ).toBe("Search for a command to run.");
  });

  it("has every supported locale for every phrase", () => {
    const merged = mergeCopy([
      { file: "overlays-copy.ts", entries: overlaysCopy },
    ]);
    expect(() => {
      assertCatalogParity(merged);
    }).not.toThrow();
  });
});
