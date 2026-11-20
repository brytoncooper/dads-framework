import { describe, expect, it } from "vitest";
import { defineGlossary, glossaryCatalog } from "./glossary.js";

/**
 * What: the glossary SHAPE — a noun, its plural, and the three ordinary copy
 * keys each entry projects into.
 * Why: the words themselves belong to a product, so
 * what the kit owes is that the shape can hold them. The fixtures below are
 * made up on purpose; a kit test naming a real product's nouns would re-couple
 * exactly what the split cut.
 */

describe("defineGlossary", () => {
  it("keeps its keys literal, so a typo is a compile error", () => {
    const glossary = defineGlossary({
      "glossary.widget": {
        one: { en: "Widget" },
        other: { en: "Widgets" },
      },
    });

    expect(glossary["glossary.widget"].one.en).toBe("Widget");
  });
});

describe("glossaryCatalog", () => {
  it("gives every noun a bare key and a plural pair", () => {
    const catalog = glossaryCatalog({
      "glossary.venue": {
        one: { en: "Venue" },
        other: { en: "Venues" },
      },
    });

    expect(catalog).toEqual({
      "glossary.venue": { en: "Venue" },
      "glossary.venue_one": { en: "Venue" },
      "glossary.venue_other": { en: "Venues" },
    });
  });

  it("projects three keys per noun, however many nouns there are", () => {
    const catalog = glossaryCatalog({
      "glossary.widget": {
        one: { en: "Widget" },
        other: { en: "Widgets" },
      },
      "glossary.gadget": {
        one: { en: "Gadget" },
        other: { en: "Gadgets" },
      },
    });

    expect(Object.keys(catalog)).toHaveLength(6);
  });
});
