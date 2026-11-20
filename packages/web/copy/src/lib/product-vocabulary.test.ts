import { describe, expect, it } from "vitest";
import { defineCopy } from "./localized-text.js";
import { mergeCopy } from "./merge-copy.js";
import {
  checkProductVocabulary,
  defineProductVocabulary,
} from "./product-vocabulary.js";

/**
 * What: the three kinds of refusal — a word refused everywhere, a word refused
 * except inside one compound, and a word refused only where it NAMES a screen.
 * Why: a rule that reads rendered JSX cannot see phrases after they move into a
 * catalog, so the merged catalog needs the same boundary WITH context, and
 * context is where this check earns its keep.
 *
 * The vocabulary below is a FIXTURE. The words a product actually refuses live
 * with that product, which is what lets a second
 * product refuse a different set without editing the kit.
 */

const FEATURE_FILE = "libs/example/web/copy/example-copy.ts";

/** One refusal of each kind, so every branch has a case it alone can fail. */
const EXAMPLE_VOCABULARY = defineProductVocabulary([
  {
    words: ["folder"],
    guidance: "Name grouping surfaces Collection.",
    onlyAsAName: true,
  },
  {
    words: ["widget bundle", "widget bundles"],
    guidance: "The customer-facing name is Kits.",
  },
  {
    words: ["draft", "drafts"],
    guidance: "Name what is drafted; a Shipping Draft is a separate entity.",
    rightAfter: "shipping",
  },
]);

function refusedIn(entries: Readonly<Record<string, { readonly en: string }>>) {
  return checkProductVocabulary(
    mergeCopy([{ file: FEATURE_FILE, entries: defineCopy(entries) }]),
    EXAMPLE_VOCABULARY,
  );
}

describe("checkProductVocabulary", () => {
  it("refuses a word wherever it appears, whatever its case", () => {
    const violations = refusedIn({
      "example.kits.title": { en: "Widget Bundles" },
      "example.kits.description": { en: "Every widget bundle you sell." },
    });

    expect(violations.map(({ found }) => found)).toEqual([
      "Widget Bundles",
      "widget bundle",
    ]);
  });

  it("names the key, the file and what to write instead", () => {
    const [violation] = refusedIn({
      "example.kits.title": { en: "Widget Bundle" },
    });

    expect(violation).toMatchObject({
      key: "example.kits.title",
      file: FEATURE_FILE,
      locale: "en",
      found: "Widget Bundle",
      guidance: "The customer-facing name is Kits.",
    });
  });

  it("keeps the compound the word is right inside, and refuses it alone", () => {
    const refused = refusedIn({
      "example.orderDraft.title": { en: "Order Drafts" },
    });
    const allowed = refusedIn({
      "example.shippingDrafts.title": { en: "Shipping Drafts" },
      "example.shippingDraft.title": { en: "Shipping Draft" },
    });

    expect(refused.map(({ found }) => found)).toEqual(["Drafts"]);
    expect(allowed).toEqual([]);
  });

  it("refuses a naming word in any case when the key names a surface", () => {
    const violations = refusedIn({
      "example.page.title": { en: "Folder" },
      "example.nav.folder": { en: "folder" },
    });

    expect(violations.map(({ key }) => key)).toEqual([
      "example.page.title",
      "example.nav.folder",
    ]);
  });

  it("allows a naming word in ordinary prose where it names nothing", () => {
    expect(
      refusedIn({
        "example.description": {
          en: "Folder contents stay where you put them.",
        },
        "example.count_other": { en: "{count} folders" },
      }),
    ).toEqual([]);
  });

  it("refuses a naming word used mid-sentence as a proper product name", () => {
    const violations = refusedIn({
      "example.action.open": { en: "Open Folder" },
      "example.description": { en: "Review access in Folder." },
    });

    expect(violations.map(({ key }) => key).sort()).toEqual([
      "example.action.open",
      "example.description",
    ]);
  });

  it("refuses a naming word that opens a phrase naming a screen", () => {
    const violations = refusedIn({
      "example.description": { en: "Folder page shows every grouping." },
    });

    expect(violations.map(({ found }) => found)).toEqual(["Folder"]);
  });

  it("finds nothing when the vocabulary is empty", () => {
    const merged = mergeCopy([
      {
        file: FEATURE_FILE,
        entries: defineCopy({ "example.page.title": { en: "Folder" } }),
      },
    ]);

    expect(checkProductVocabulary(merged, [])).toEqual([]);
  });
});
