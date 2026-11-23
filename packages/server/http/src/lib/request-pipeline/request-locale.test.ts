import { describe, expect, it } from "vitest";
import { DEFAULT_REQUEST_LOCALE, preferredLocaleOf, requestLocaleOf, resolveRequestLocale } from "./request-locale.js";

/**
 * What: an `Accept-Language` header, however hostile, becomes one language this
 * product speaks.
 * Why: this read runs on every request, so it must never throw — a request
 * answered in the wrong language is a nuisance and a request refused for its
 * language is an outage. The ranking cases go through `preferredLocaleOf` with a
 * second language named, because `SUPPORTED_LOCALES` holds only `en`: every
 * answer `resolveRequestLocale` can give is English, so asserting `"en"` there
 * would pass whatever the weights did.
 */

/** What the supported list looks like the day Spanish lands. */
const TWO_LOCALES = ["en", "es"];

/** Typed, because a bare `[]` narrows the tag type to `never`. */
const NO_LOCALES: readonly string[] = [];

describe("preferredLocaleOf", () => {
  it("takes the highest-weighted tag it can serve", () => {
    expect(preferredLocaleOf("es;q=0.9,en;q=0.8", TWO_LOCALES)).toBe("es");
    expect(preferredLocaleOf("es;q=0.2,en;q=0.7", TWO_LOCALES)).toBe("en");
  });

  it("reads a regional tag as its language — es-MX is Spanish", () => {
    expect(preferredLocaleOf("es-MX", TWO_LOCALES)).toBe("es");
    expect(preferredLocaleOf("en-GB", TWO_LOCALES)).toBe("en");
  });

  it("skips a language this product does not speak, however wanted", () => {
    expect(preferredLocaleOf("fr,es;q=0.1", TWO_LOCALES)).toBe("es");
    expect(preferredLocaleOf("fr,de-DE;q=0.8", TWO_LOCALES)).toBeUndefined();
  });

  it("ignores a tag the client explicitly refused with q=0", () => {
    expect(preferredLocaleOf("es;q=0,en", TWO_LOCALES)).toBe("en");
  });

  it("weighs an unreadable q FULL rather than dropping the tag", () => {
    expect(preferredLocaleOf("es;q=,en;q=0.9", TWO_LOCALES)).toBe("es");
    expect(preferredLocaleOf("es;;q=,en;q=0.9", TWO_LOCALES)).toBe("es");
    expect(preferredLocaleOf("es;q=   ,en;q=0.9", TWO_LOCALES)).toBe("es");
    expect(preferredLocaleOf("es;q=banana,en;q=0.9", TWO_LOCALES)).toBe("es");
  });

  it("treats the wildcard as no preference at all", () => {
    expect(preferredLocaleOf("*", TWO_LOCALES)).toBeUndefined();
  });

  it("names nothing when the supported list is empty", () => {
    expect(preferredLocaleOf("en", NO_LOCALES)).toBeUndefined();
  });
});

describe("resolveRequestLocale", () => {
  it("honors a plain supported tag", () => {
    expect(resolveRequestLocale("en")).toBe("en");
  });

  it("reads a regional tag as its language — en-GB is English", () => {
    expect(resolveRequestLocale("en-GB")).toBe("en");
  });

  it("answers English for a language this product does not speak", () => {
    expect(resolveRequestLocale("fr")).toBe("en");
    expect(resolveRequestLocale("de-DE,fr-CA;q=0.8")).toBe("en");
  });

  it("answers English for an absent, blank or nonsense header", () => {
    for (const header of [undefined, null, "", "   ", 42, {}, ",,,"]) {
      expect(resolveRequestLocale(header)).toBe(DEFAULT_REQUEST_LOCALE);
    }
  });

  it("reads a repeated header Fastify handed through as an array", () => {
    expect(resolveRequestLocale(["fr", "en;q=0.5"])).toBe("en");
  });

  it("survives a malformed weight rather than refusing the request", () => {
    expect(resolveRequestLocale("en;q=banana")).toBe("en");
    expect(resolveRequestLocale("en;;q=")).toBe("en");
  });

  it("is case and whitespace tolerant", () => {
    expect(resolveRequestLocale("  EN-us ;q=0.9 ")).toBe("en");
  });
});

describe("requestLocaleOf", () => {
  it("reads the language off the request's own header", () => {
    expect(requestLocaleOf({ headers: { "accept-language": "en-US" } })).toBe("en");
  });

  it("answers English when the request said nothing about language", () => {
    expect(requestLocaleOf({ headers: {} })).toBe("en");
  });
});
