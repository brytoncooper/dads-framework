import { expectTypeOf } from "vitest";

import { type CopyKey, createCopyHook, defineCopy } from "../src/copy/index.js";

const exampleCopy = defineCopy({
  "sample.page.title": { en: "Orders" },
  "sample.status.DRAFT": { en: "Draft" },
  "sample.holders_one": { en: "1 person" },
  "sample.holders_other": { en: "{count} people" },
});

type CatalogKey = keyof typeof exampleCopy;
expectTypeOf<"sample.page.titel">().not.toExtend<CatalogKey>();
expectTypeOf<string>().not.toExtend<CatalogKey>();

type PluralKey = CopyKey<typeof exampleCopy>;
expectTypeOf<"sample.holders">().toExtend<PluralKey>();
expectTypeOf<"sample.holder">().not.toExtend<PluralKey>();

const useExampleCopy = createCopyHook(exampleCopy);
expectTypeOf(useExampleCopy).returns.toBeFunction();
type TranslatorKey = Parameters<ReturnType<typeof useExampleCopy>>[0];
expectTypeOf<"sample.page.title">().toExtend<TranslatorKey>();
expectTypeOf<"sample.page.titel">().not.toExtend<TranslatorKey>();
