import { useCallback } from "react";

import type { CopyDescriptor, CopyVars } from "./copy-descriptor.js";
import { useLocale } from "./locale-provider.js";
import type { CopyCatalog } from "./localized-text.js";
import { type CopyKey, translate } from "./translate.js";

/**
 * A feature's own translator, closed over a feature's own words.
 *
 * This is where the blast-radius rule is actually enforced. The hook reads only
 * the LOCALE from React context — never a catalog — so nothing every feature
 * contributes to is consulted at render time, and editing an orders label
 * cannot mark products affected. The app-level merge exists for the
 * duplicate-key and glossary checks and has no runtime reader by design.
 */

/** What a feature's `use<Feature>Copy()` hands back. */
export type CopyTranslator<Catalog extends CopyCatalog> = (
  keyOrDescriptor: CopyKey<Catalog> | CopyDescriptor<CopyKey<Catalog>>,
  vars?: CopyVars,
  count?: number,
) => string;

/**
 * Build the hook a feature exports beside its catalog:
 *
 * ```ts
 * export const useOrdersCopy = createCopyHook(ordersCopy);
 * ```
 */
export function createCopyHook<Catalog extends CopyCatalog>(catalog: Catalog): () => CopyTranslator<Catalog> {
  return function useCopy(): CopyTranslator<Catalog> {
    const locale = useLocale();
    return useCallback(
      (keyOrDescriptor, vars, count) => translate(catalog, locale, keyOrDescriptor, vars, count),
      [locale],
    );
  };
}
