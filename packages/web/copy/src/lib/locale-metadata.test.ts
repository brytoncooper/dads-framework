/**
 * What: every supported locale declares the document direction it needs.
 * Why: screen readers and browser layout must follow the same reader locale as
 * visible copy, without a scattered language-name conditional in the app.
 */
import { describe, expect, it } from "vitest";
import { LOCALE_METADATA, textDirectionForLocale } from "./locale-metadata.js";

describe("locale metadata", () => {
  it("declares English as left-to-right", () => {
    expect(LOCALE_METADATA.en).toEqual({ direction: "ltr" });
    expect(textDirectionForLocale("en")).toBe("ltr");
  });
});
