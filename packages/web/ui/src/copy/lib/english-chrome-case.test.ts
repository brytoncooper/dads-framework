import { describe, expect, it } from "vitest";
import { checkEnglishChromeCase } from "./english-chrome-case.js";
import { defineCopy } from "./localized-text.js";
import { mergeCopy } from "./merge-copy.js";

/**
 * What: English buttons and titles follow the product's authored Title Case
 * rule while field labels, columns, and errors remain free of that rule.
 * Why: catalogs centralize copy but do not make inconsistent casing correct;
 * this wall catches the exact `Add company` drift the migration set out to end
 * without forcing ALL-CAPS column headers or sentence-case button names.
 */

const ORDERS_FILE = "apps/example/features/orders/src/copy/orders-copy.ts";

function ordersCopy(entries: Readonly<Record<string, { readonly en: string }>>) {
  return mergeCopy([{ file: ORDERS_FILE, entries: defineCopy(entries) }]);
}

describe("checkEnglishChromeCase", () => {
  it("accepts authored Title Case, including lowercase connecting words", () => {
    const merged = ordersCopy({
      "orders.action.add": { en: "Add Order" },
      "orders.dialog.title": { en: "Add Order to Company" },
      "orders.article.title": { en: "A Company" },
      "orders.member.removeLabel": { en: "Remove {memberName}" },
    });

    expect(checkEnglishChromeCase(merged)).toEqual([]);
  });

  it("names sentence-cased chrome and its owning file", () => {
    const merged = ordersCopy({
      "orders.action.add": { en: "Add order" },
      "orders.dialog.title": { en: "Create order" },
    });

    expect(checkEnglishChromeCase(merged)).toEqual([
      {
        key: "orders.action.add",
        file: ORDERS_FILE,
        phrase: "Add order",
      },
      {
        key: "orders.dialog.title",
        file: ORDERS_FILE,
        phrase: "Create order",
      },
    ]);
  });

  it("does not treat field labels, columns, headings, or generic labels as chrome", () => {
    const merged = ordersCopy({
      "orders.filter.heading.empty": { en: "No filters applied" },
      "orders.field.loads": { en: "LOADS" },
      "orders.column.companyName": { en: "Company name" },
      "orders.products.remove.label": { en: "Stop sharing {productName}" },
    });

    expect(checkEnglishChromeCase(merged)).toEqual([]);
  });

  it("rejects all-uppercase buttons and titles while preserving initialisms", () => {
    const merged = ordersCopy({
      "orders.action.create": { en: "CREATE ORDER" },
      "orders.page.title": { en: "HMI" },
      "orders.action.export": { en: "Export CSV" },
      "orders.sso.title": { en: "Add a Custom SAML App" },
      "orders.oidc.title": { en: "Or Use OIDC Instead" },
    });

    expect(checkEnglishChromeCase(merged)).toEqual([
      {
        key: "orders.action.create",
        file: ORDERS_FILE,
        phrase: "CREATE ORDER",
      },
    ]);
  });

  it("does not treat field help and placeholders as chrome labels", () => {
    const merged = ordersCopy({
      "orders.field.companyPlaceholder": { en: "name@company.com" },
      "orders.field.companyDescription": {
        en: "Choose the company receiving this order.",
      },
    });

    expect(checkEnglishChromeCase(merged)).toEqual([]);
  });

  it("does not apply the chrome rule to error titles or prose", () => {
    const merged = ordersCopy({
      "orders.error.load.title": { en: "Orders could not be loaded" },
      "orders.readError.title": { en: "Orders could not be loaded" },
      "orders.page.description": { en: "Review orders for this company." },
    });

    expect(checkEnglishChromeCase(merged)).toEqual([]);
  });
});
