import type { CopyCatalog, LocalizedText } from "./localized-text.js";

/**
 * The shape of a product's shared nouns — never the nouns themselves.
 *
 * A glossary is the handful of words two or more of a product's features must
 * spell identically. Which words those are is the product's business, so the entries live with the
 * product and only the shape, the
 * declaration helper and the catalog projection live here. A kit holding one
 * product's vocabulary would make every other product read it as noise.
 */

/** One noun and its plural. */
export type GlossaryEntry = {
  readonly one: LocalizedText;
  readonly other: LocalizedText;
};

export type Glossary = Readonly<Record<string, GlossaryEntry>>;

/** Declare the glossary and keep its keys literal, exactly as `defineCopy`. */
export function defineGlossary<const T extends Glossary>(glossary: T): T {
  return glossary;
}

/**
 * The glossary as ordinary copy, so a feature reads a shared noun through the
 * same hook it reads its own words with.
 *
 * Each entry becomes three keys: the entry's own key, for a label that names
 * one thing, and the `_one` / `_other` pair the plural machinery selects
 * between when a count is present.
 */
export function glossaryCatalog(glossary: Glossary): CopyCatalog {
  const catalog: Record<string, LocalizedText> = {};
  for (const [key, entry] of Object.entries(glossary)) {
    catalog[key] = entry.one;
    catalog[`${key}_one`] = entry.one;
    catalog[`${key}_other`] = entry.other;
  }
  return catalog;
}
