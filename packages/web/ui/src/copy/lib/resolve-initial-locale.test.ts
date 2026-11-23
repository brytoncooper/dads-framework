import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  matchSupportedLocale,
  resolveInitialLocale,
  resolveLocaleFromSignals,
} from "./resolve-initial-locale.js";

/**
 * What: which language a reader gets — saved choice, then the browser's list in
 * its own order, then English — and the region-tolerant tag match underneath.
 * Why: browsers send `es-MX` and `es-419`, so an exact-match rule would answer
 * English to a reader who plainly asked for Spanish. The supported list is
 * injected because the shipped tuple holds one entry: assert through it and
 * every case passes on the fallback whatever the matching did.
 */

/** What the supported list looks like the day Spanish lands. */
const TWO_LOCALES = ["en", "es"];
const NO_LOCALES: readonly string[] = [];

describe("matchSupportedLocale", () => {
  it("matches an exact tag", () => {
    expect(matchSupportedLocale("es", TWO_LOCALES)).toBe("es");
  });

  it("matches a regional tag to its language — es-MX is Spanish", () => {
    expect(matchSupportedLocale("es-MX", TWO_LOCALES)).toBe("es");
    expect(matchSupportedLocale("es-419", TWO_LOCALES)).toBe("es");
    expect(matchSupportedLocale("en-GB", TWO_LOCALES)).toBe("en");
  });

  it("is case and whitespace tolerant — browsers are not consistent", () => {
    expect(matchSupportedLocale("  ES-mx ", TWO_LOCALES)).toBe("es");
  });

  it("names nothing for a language this product does not speak", () => {
    expect(matchSupportedLocale("fr", TWO_LOCALES)).toBeUndefined();
    expect(matchSupportedLocale("", TWO_LOCALES)).toBeUndefined();
    expect(matchSupportedLocale("en", NO_LOCALES)).toBeUndefined();
  });
});

describe("resolveInitialLocale", () => {
  it("takes the reader's saved choice over anything the browser says", () => {
    expect(
      resolveInitialLocale({
        preferred: "en",
        browserLanguages: ["fr-FR", "de"],
      }),
    ).toBe("en");
  });

  it("falls to the browser's list, in the order the browser gave it", () => {
    expect(resolveInitialLocale({ browserLanguages: ["fr-FR", "en-GB"] })).toBe("en");
  });

  it("ignores a saved choice this product no longer speaks", () => {
    expect(resolveInitialLocale({ preferred: "fr", browserLanguages: ["en"] })).toBe("en");
  });

  it("answers English when no signal names a supported language", () => {
    expect(resolveInitialLocale({ browserLanguages: ["fr", "de"] })).toBe(DEFAULT_LOCALE);
  });

  it("answers English when there are no signals at all", () => {
    expect(resolveInitialLocale({})).toBe(DEFAULT_LOCALE);
  });

  it("never throws — an unreadable signal is a fallback, not a failure", () => {
    expect(resolveInitialLocale({ preferred: "", browserLanguages: [""] })).toBe(DEFAULT_LOCALE);
  });
});

describe("resolveLocaleFromSignals", () => {
  it("uses the first supported browser language when no account choice exists", () => {
    expect(resolveLocaleFromSignals({ browserLanguages: ["fr-FR", "es-MX", "en-US"] }, TWO_LOCALES, "en")).toBe("es");
  });

  it("lets the saved account choice override the browser", () => {
    expect(resolveLocaleFromSignals({ preferred: "en", browserLanguages: ["es-MX"] }, TWO_LOCALES, "en")).toBe("en");
  });

  it("treats a null account choice as Automatic and follows the browser", () => {
    expect(resolveLocaleFromSignals({ preferred: null, browserLanguages: ["es-419"] }, TWO_LOCALES, "en")).toBe("es");
  });
});
