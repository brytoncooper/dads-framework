import { describe, expect, it } from "vitest";
import {
  assertCatalogParity,
  checkCatalogParity,
  placeholdersOf,
} from "./catalog-parity.js";
import { defineCopy, type LocalizedText } from "./localized-text.js";
import { mergeCopy, type CopySource } from "./merge-copy.js";

/**
 * What: every gap between the reference locale and a translated one, reported
 * as a worklist that names the key, the file and the locale.
 * Why: this check is dead weight until a second language ships, and by then a
 * broken one is discovered by a translator reading a diff. So the locale list is
 * injected here and the multi-locale cases are proven now, while the answer is
 * still cheap to get wrong.
 */

const ORDERS_FILE = "apps/example/features/orders/src/copy/orders-copy.ts";
const FACILITIES_FILE =
  "apps/example/features/facilities/src/copy/facilities-copy.ts";

/**
 * The locale list is injected so these cases can prove what happens when a
 * SECOND locale lands — the situation this check exists for, and the one the
 * shipped `SUPPORTED_LOCALES` cannot express today.
 */
const TWO_LOCALES = ["en", "es"];

/**
 * A source built from raw tag→phrase pairs, so a case can express the
 * half-translated catalog a real translation pass produces — which the shipped
 * one-locale `LocalizedText` deliberately cannot.
 */
function ordersSource(
  entries: Record<string, Record<string, string>>,
): CopySource {
  const catalog: Record<string, LocalizedText> = {};
  for (const [key, translations] of Object.entries(entries)) {
    catalog[key] = { ...translations, en: translations["en"] ?? "" };
  }
  return { file: ORDERS_FILE, entries: catalog };
}

describe("placeholdersOf", () => {
  it("names every interpolation slot once", () => {
    expect([...placeholdersOf("{count} of {count} at {facility}")]).toEqual([
      "count",
      "facility",
    ]);
  });

  it("finds none in a plain sentence", () => {
    expect(placeholdersOf("Nothing to ship yet.").size).toBe(0);
  });
});

describe("checkCatalogParity", () => {
  it("passes a catalog that speaks every locale", () => {
    const merged = mergeCopy([
      ordersSource({ "orders.page.title": { en: "Orders", es: "Pedidos" } }),
    ]);

    expect(checkCatalogParity(merged, TWO_LOCALES)).toEqual({
      missingTranslations: [],
      malformedPlaceholders: [],
      placeholderMismatches: [],
      pluralFallbackGaps: [],
    });
  });

  it("names the key AND the file of every phrase a new locale still needs", () => {
    const merged = mergeCopy([
      ordersSource({
        "orders.page.title": { en: "Orders", es: "Pedidos" },
        "orders.status.DRAFT": { en: "Draft" },
      }),
    ]);

    expect(checkCatalogParity(merged, TWO_LOCALES).missingTranslations).toEqual(
      [{ key: "orders.status.DRAFT", file: ORDERS_FILE, locale: "es" }],
    );
  });

  it("treats an empty phrase as untranslated rather than as a translation", () => {
    const merged = mergeCopy([
      ordersSource({ "orders.page.title": { en: "Orders", es: "" } }),
    ]);

    expect(
      checkCatalogParity(merged, TWO_LOCALES).missingTranslations,
    ).toHaveLength(1);
  });

  it("treats a whitespace-only phrase as untranslated", () => {
    const merged = mergeCopy([
      ordersSource({ "orders.page.title": { en: "Orders", es: " \n\t " } }),
    ]);

    expect(checkCatalogParity(merged, TWO_LOCALES).missingTranslations).toEqual(
      [{ key: "orders.page.title", file: ORDERS_FILE, locale: "es" }],
    );
  });

  it("names malformed placeholders with their key, file, locale, and token", () => {
    const merged = mergeCopy([
      ordersSource({
        "orders.company": {
          en: "Orders for {companyName}",
          es: "Pedidos de {company-name}",
        },
      }),
    ]);

    expect(
      checkCatalogParity(merged, TWO_LOCALES).malformedPlaceholders,
    ).toEqual([
      {
        key: "orders.company",
        file: ORDERS_FILE,
        locale: "es",
        token: "{company-name}",
      },
    ]);
  });

  it("catches a translation that dropped an interpolation slot", () => {
    const merged = mergeCopy([
      ordersSource({
        "orders.holders_other": {
          en: "{count} people",
          es: "varias personas",
        },
      }),
    ]);

    expect(
      checkCatalogParity(merged, TWO_LOCALES).placeholderMismatches,
    ).toEqual([
      {
        key: "orders.holders_other",
        file: ORDERS_FILE,
        locale: "es",
        missing: ["count"],
        unexpected: [],
      },
    ]);
  });

  it("catches a translation that invented a slot nothing will fill", () => {
    const merged = mergeCopy([
      ordersSource({
        "orders.empty": { en: "Nothing here", es: "Nada en {facility}" },
      }),
    ]);

    const [mismatch] = checkCatalogParity(
      merged,
      TWO_LOCALES,
    ).placeholderMismatches;

    expect(mismatch?.unexpected).toEqual(["facility"]);
  });

  it("refuses to measure against no locale at all", () => {
    expect(() => checkCatalogParity(mergeCopy([]), [])).toThrow(
      /at least one locale/,
    );
  });

  it("is trivially satisfied by the one locale shipping today", () => {
    const merged = mergeCopy([
      ordersSource({ "orders.page.title": { en: "Orders" } }),
    ]);

    expect(checkCatalogParity(merged)).toEqual({
      missingTranslations: [],
      malformedPlaceholders: [],
      placeholderMismatches: [],
      pluralFallbackGaps: [],
    });
  });

  it("names a plural family and its owner when the _other fallback is missing", () => {
    const merged = mergeCopy([
      ordersSource({
        "orders.holders_one": { en: "{count} member", es: "{count} miembro" },
      }),
    ]);

    expect(checkCatalogParity(merged, TWO_LOCALES).pluralFallbackGaps).toEqual([
      {
        key: "orders.holders",
        file: ORDERS_FILE,
        missingKey: "orders.holders_other",
      },
    ]);
  });

  it("requires _other inside each runtime owner instead of across the merged app", () => {
    const merged = mergeCopy([
      ordersSource({
        "shared.holders_one": { en: "{count} member", es: "{count} miembro" },
      }),
      {
        file: FACILITIES_FILE,
        entries: defineCopy({
          "shared.holders_other": {
            en: "{count} members",
          },
        }),
      },
    ]);

    expect(checkCatalogParity(merged).pluralFallbackGaps).toEqual([
      {
        key: "shared.holders",
        file: ORDERS_FILE,
        missingKey: "shared.holders_other",
      },
    ]);
  });
});

describe("assertCatalogParity", () => {
  it("says nothing when every phrase is present", () => {
    const merged = mergeCopy([
      ordersSource({ "orders.page.title": { en: "Orders", es: "Pedidos" } }),
    ]);

    expect(() => {
      assertCatalogParity(merged, TWO_LOCALES);
    }).not.toThrow();
  });

  it("fails with the worklist itself — every key, every file", () => {
    const merged = mergeCopy([
      ordersSource({
        "orders.page.title": { en: "Orders" },
        "orders.status.DRAFT": { en: "Draft" },
      }),
    ]);

    expect(() => {
      assertCatalogParity(merged, TWO_LOCALES);
    }).toThrow(
      /2 copy entries need work[\s\S]*orders\.page\.title[\s\S]*orders\.status\.DRAFT/,
    );
  });

  it("fails before runtime when a plural family has no _other fallback", () => {
    const merged = mergeCopy([
      ordersSource({
        "orders.holders_one": { en: "{count} member", es: "{count} miembro" },
      }),
    ]);

    expect(() => {
      assertCatalogParity(merged, TWO_LOCALES);
    }).toThrow(/orders\.holders.*orders-copy\.ts.*orders\.holders_other/s);
  });

  it("fails before runtime when a placeholder name is malformed", () => {
    const merged = mergeCopy([
      ordersSource({
        "orders.company": { en: "Orders for {company-name}" },
      }),
    ]);

    expect(() => {
      assertCatalogParity(merged);
    }).toThrow(/orders\.company.*orders-copy\.ts.*\{company-name\}/s);
  });
});
