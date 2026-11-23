import { describe, expect, it } from "vitest";
import { defineCopy } from "./localized-text.js";
import { mergeCopy } from "./merge-copy.js";

/**
 * What: every registered catalog gathered under one key space, each phrase
 * keeping the file it came from, and the throw when two features claim one key.
 * Why: the merged catalog is proof, never a render path, so this suite is the
 * only place the duplicate-key wall is watched failing. The assertion names BOTH
 * files on purpose — a collision message carrying only the key tells whoever
 * reads it nothing about which two catalogs to open.
 */

const ordersCopy = defineCopy({
  "orders.page.title": { en: "Orders" },
  "orders.status.DRAFT": { en: "Draft" },
});

const productsCopy = defineCopy({
  "products.page.title": { en: "Products" },
});

const ordersSource = {
  file: "apps/example/features/orders/src/copy/orders-copy.ts",
  entries: ordersCopy,
};

const productsSource = {
  file: "apps/example/features/products/src/copy/products-copy.ts",
  entries: productsCopy,
};

describe("mergeCopy", () => {
  it("gathers every catalog under one key space", () => {
    const merged = mergeCopy([ordersSource, productsSource]);

    expect([...merged.keys()]).toEqual(["orders.page.title", "orders.status.DRAFT", "products.page.title"]);
  });

  it("keeps provenance, so a failure can name the file to open", () => {
    const merged = mergeCopy([ordersSource, productsSource]);

    expect(merged.get("products.page.title")).toEqual({
      text: { en: "Products" },
      file: "apps/example/features/products/src/copy/products-copy.ts",
    });
  });

  it("throws on a duplicate key, naming the key and BOTH files", () => {
    const collidingSource = {
      file: "apps/example/features/companies/src/copy/companies-copy.ts",
      entries: defineCopy({ "orders.page.title": { en: "Order desk" } }),
    };

    expect(() => mergeCopy([ordersSource, collidingSource])).toThrow(
      /"orders\.page\.title".*orders\/src\/copy\/orders-copy\.ts.*companies\/src\/copy\/companies-copy\.ts/s,
    );
  });

  it("merges an empty registration into an empty catalog", () => {
    expect(mergeCopy([]).size).toBe(0);
  });
});
