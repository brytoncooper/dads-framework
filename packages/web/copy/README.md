# @dads-framework/copy

The machinery every word a product says goes through, and no product's words.

A catalog entry is written side by side — `{ "orders.page.title": { en: "Orders" } }`
— so one line holds a phrase in every language the product speaks, and adding a
language is a column rather than a second file that can drift. Keys are derived
from the catalog with `keyof typeof`, so a typo is a compile error rather than a
screen that renders `orders.page.titel`.

## The law: mechanism here, words with the product

**No file in this kit defines a glossary entry or a refused word.** Not one
noun, not one product name — those are a product's business,
and a kit that held one product's vocabulary would be noise in every other.
So `defineGlossary`, `glossaryCatalog`,
`defineProductVocabulary` and `checkProductVocabulary` all take the words as an
argument, and each application keeps its own words in its own package. Test fixtures can use sample vocabulary to exercise the checks.

**Here:** the types (`LocalizedText`, `CopyCatalog`, `defineCopy`), the resolver
(`translate`, `createCopyHook`), the copy descriptor pure logic returns instead
of a stitched sentence, the merge that refuses a duplicate key, the parity
assertion that names the worklist when a locale is added, the locale provider
and formatting seams, and the vocabulary sweep that judges a merged catalog
against words handed to it.

**Not here:** any feature's words, and any product's vocabulary. Each feature
lib owns its own catalog under `src/copy/`, which is what keeps editing an
orders label from marking products affected. The app merges the catalogs at
composition for **proof only** — the duplicate-key check and the vocabulary
sweep. Nothing resolves a rendered string through the merged
catalog, and a component that starts to would turn every label edit into an
app-wide edit.

One English rule does live here and is worth naming out loud:
`checkEnglishChromeCase` carries a list of initialisms that may stay all-caps
(`API`, `CSV`, `SKU`, `SSO`…). That is a spelling allowlist for a typography
rule, not a product's vocabulary — it decides how a word is capitalized, never
whether the product may say it.

## A glossary holds the shared nouns

Each glossary entry carries a noun's singular and plural, so two features that
name the same thing spell it identically.

Bare nouns reference glossary keys. **Whole sentences never do** — a sentence
built by stitching a glossary noun into a template is a grammar bug waiting for
the second language, so a sentence is one catalog entry written naturally in
each locale.

## Scope and tags

`scope:shared` + `type:util`. The kit imports React and `Intl` and nothing else
— no contracts, no client libs, no product — which is what lets a `scope:shared`
`ui-primitives` lib reach it later without moving a boundary.
