import { describe, expect, it } from "vitest";
import {
  LOCALE_HEADER,
  SUPPORTED_LOCALES,
  localizedTextSchema,
  type Locale,
  type LocalizedText,
} from "./locale.js";

/**
 * What: `SUPPORTED_LOCALES` and `localizedTextSchema` describe the same set of
 * languages, in both directions, and the schema refuses a locale nobody speaks
 * and a translation nobody wrote.
 * Why: the two are hand-kept in step, and drift between them is silent — a
 * locale in the tuple but not the schema makes `strictObject` reject a phrase
 * that is correctly written, and one in the schema but not the tuple makes a
 * label render blank in that language. The two assignments below are what turn
 * that into a COMPILE error in this file: each fails in one direction only, so
 * `typecheck` is their gate and a green run alone never proves them.
 */

function everyLocaleHasAPhrase(text: LocalizedText): Record<Locale, string> {
  return text;
}

function everyPhraseNamesALocale(text: Record<Locale, string>): LocalizedText {
  return text;
}

describe("locale primitives", () => {
  it("speaks English, and the tuple is the only place that says so", () => {
    expect(SUPPORTED_LOCALES).toEqual(["en"]);
  });

  it("keeps the tuple and the schema describing the same set", () => {
    const phrase = localizedTextSchema.parse({ en: "Facilities" });

    expect(everyLocaleHasAPhrase(phrase)).toEqual({ en: "Facilities" });
    expect(everyPhraseNamesALocale({ en: "Facilities" })).toEqual(phrase);
  });

  it("refuses a locale nobody supports rather than ignoring it", () => {
    expect(
      localizedTextSchema.safeParse({ en: "Facilities", es: "Plantas" })
        .success,
    ).toBe(false);
  });

  it("refuses an unwritten translation rather than shipping a blank label", () => {
    expect(localizedTextSchema.safeParse({ en: "" }).success).toBe(false);
    expect(localizedTextSchema.safeParse({}).success).toBe(false);
  });

  it("names the header the reader's language arrives on", () => {
    expect(LOCALE_HEADER).toBe("accept-language");
  });
});
