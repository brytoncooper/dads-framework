import { describe, expect, it } from "vitest";
import {
  SUPPORTED_LOCALES,
  defineCopy,
  isSupportedLocale,
  resolveLocalizedText,
  type Locale,
} from "./localized-text.js";

/**
 * What: `defineCopy` keeping a catalog's keys literal, the supported-locale
 * tuple and its guard, and reading one language out of a side-by-side phrase.
 * Why: the literal keys ARE the guarantee this kit exists for — widen them to
 * `string` and a typo'd key compiles, which is the failure everything else here
 * is built to prevent. The compiler checks key rejection in type-tests.
 */

const sampleCopy = defineCopy({
  "sample.page.title": { en: "Orders" },
  "sample.status.DRAFT": { en: "Draft" },
});

type SampleCopyKey = keyof typeof sampleCopy;

describe("defineCopy", () => {
  it("returns the catalog untouched — it is identity at runtime", () => {
    const catalog = { "sample.key": { en: "Hello" } };
    expect(defineCopy(catalog)).toBe(catalog);
  });

  it("keeps keys literal, so a declared key is assignable", () => {
    const declared: SampleCopyKey = "sample.page.title";
    expect(sampleCopy[declared].en).toBe("Orders");
  });
});

describe("SUPPORTED_LOCALES", () => {
  it("speaks English today, and the tuple is the only place that says so", () => {
    expect(SUPPORTED_LOCALES).toEqual(["en"]);
  });

  it("recognizes a supported tag and refuses anything else", () => {
    expect(isSupportedLocale("en")).toBe(true);
    expect(isSupportedLocale("es")).toBe(false);
    expect(isSupportedLocale("en-US")).toBe(false);
    expect(isSupportedLocale("")).toBe(false);
  });
});

describe("resolveLocalizedText", () => {
  it("reads the asked-for locale", () => {
    const locale: Locale = "en";
    expect(resolveLocalizedText({ en: "Facilities" }, locale)).toBe(
      "Facilities",
    );
  });

  it("accepts a structurally identical phrase declared elsewhere", () => {
    // The contract kit declares its own `LocalizedText` because a contract lib
    // cannot reach `scope:shared`. This is the shape it produces.
    const fromContractKit: { readonly en: string } = { en: "Draft" };
    expect(resolveLocalizedText(fromContractKit, "en")).toBe("Draft");
  });
});
