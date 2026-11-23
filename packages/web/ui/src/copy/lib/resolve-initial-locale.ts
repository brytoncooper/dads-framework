import { SUPPORTED_LOCALES, type Locale } from "./localized-text.js";

/**
 * Which language a reader gets from signals in priority order.
 *
 * A reader's language is a property of the READER, not of the tenant they are
 * looking at — a bilingual operator working two organizations would otherwise
 * change language by changing workspace. `organizations.locale` and
 * `facilities.locale` exist in the schema and nothing reads them; that is
 * deliberate and recorded, not an oversight.
 *
 * `preferred` is the seam the identity-owned User Settings document arrives
 * through. A saved locale wins; null means Automatic and follows the browser.
 * Nothing here reads or writes browser storage, because a preference stored in
 * two places is a preference that disagrees with itself.
 */

/** The language every reader gets when no signal names a supported one. */
export const DEFAULT_LOCALE: Locale = SUPPORTED_LOCALES[0];

export type LocaleSignals = {
  /** The reader's saved choice; null means Automatic/browser fallback. */
  readonly preferred?: string | null | undefined;
  /** What the browser says the reader reads, most-wanted first. */
  readonly browserLanguages?: readonly string[] | undefined;
};

/**
 * The supported locale a language tag names, or nothing.
 *
 * Region-tolerant by necessity: browsers send `es-MX`, `es-419` and `en-GB`,
 * and a reader who asked for Mexican Spanish wants Spanish rather than English.
 * The supported list is a parameter so this can be proven against a second
 * locale today, before one ships.
 */
export function matchSupportedLocale<const TLocale extends string>(
  tag: string,
  supported: readonly TLocale[],
): TLocale | undefined {
  const normalized = tag.trim().toLowerCase();
  if (normalized === "") return undefined;
  const exact = supported.find((locale) => locale.toLowerCase() === normalized);
  if (exact !== undefined) return exact;
  const primarySubtag = normalized.split("-")[0];
  return supported.find((locale) => locale.toLowerCase() === primarySubtag);
}

/** Saved choice, then the browser's list in order, then the given fallback. */
export function resolveLocaleFromSignals<const TLocale extends string>(
  signals: LocaleSignals,
  supported: readonly TLocale[],
  fallback: TLocale,
): TLocale {
  const candidates = [
    ...(signals.preferred === undefined || signals.preferred === null ? [] : [signals.preferred]),
    ...(signals.browserLanguages ?? []),
  ];
  for (const candidate of candidates) {
    const matched = matchSupportedLocale(candidate, supported);
    if (matched !== undefined) return matched;
  }
  return fallback;
}

/** Saved choice, then the browser's list in order, then English. */
export function resolveInitialLocale(signals: LocaleSignals): Locale {
  return resolveLocaleFromSignals(signals, SUPPORTED_LOCALES, DEFAULT_LOCALE);
}
