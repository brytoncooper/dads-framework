import {
  createCopyHook,
  defineCopy,
  type CopyKey,
  type CopyTranslator,
} from "@dads-framework/copy";

export const elementsCopy = defineCopy({
  "elements.loading.label": { en: "Loading" },
});

export type ElementsCopyKey = CopyKey<typeof elementsCopy>;
export type ElementsCopyTranslator = CopyTranslator<typeof elementsCopy>;

export const useElementsCopy = createCopyHook(elementsCopy);
