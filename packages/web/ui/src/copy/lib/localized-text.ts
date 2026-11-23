/**
 * One phrase, every language, on one line.
 *
 * The alternative — a file per locale — puts the English and the Spanish of the
 * same sentence in two places that only a tool can compare, so they drift and
 * the drift is invisible until a reader hits it. Side by side, a missing
 * translation is a missing property and the type system is the tool.
 *
 * `SUPPORTED_LOCALES` is `["en"]` today by decision, not by omission: the
 * structure ships now and Spanish is added as a reviewed second pass. When that
 * tuple grows, `assertCatalogParity` names every key that needs a translation —
 * a far better worklist than a diff.
 */

/** Every language this product speaks, in preference order. */
export const SUPPORTED_LOCALES = ["en"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** One phrase in every language this product speaks. */
export type LocalizedText = Readonly<Record<Locale, string>>;

/** A feature's words: flat keys, each holding one phrase per locale. */
export type CopyCatalog = Readonly<Record<string, LocalizedText>>;

/**
 * Declare a catalog and keep its keys literal.
 *
 * The `const` type parameter is the whole point. Without it every key widens to
 * `string`, `keyof typeof catalog` becomes `string`, and a typo'd key compiles
 * happily — which is the exact failure this kit exists to make impossible.
 */
export function defineCopy<const T extends CopyCatalog>(catalog: T): T {
  return catalog;
}

/** Narrow an arbitrary language tag to a locale this product speaks. */
export function isSupportedLocale(value: string): value is Locale {
  return SUPPORTED_LOCALES.some((locale) => locale === value);
}

/**
 * Read one locale out of a side-by-side phrase.
 *
 * Structural on purpose: the contract kit declares its own `LocalizedText`
 * because a contract lib may not reach `scope:shared`, and a value carrying the
 * same properties is accepted here without either side importing the other.
 * The application’s locale parity test is where the two tuples are
 * pinned to each other.
 */
export function resolveLocalizedText(
  text: LocalizedText,
  locale: Locale,
): string {
  return text[locale];
}
