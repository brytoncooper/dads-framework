import type { CopyCatalog, LocalizedText } from "./localized-text.js";

/**
 * Every feature's catalog, gathered in one place for PROOF — never for
 * resolution.
 *
 * A component resolves through its own feature's catalog and reads only the
 * locale from context, which is what makes editing an orders label affect
 * orders and nothing else. The merged object exists so two checks have
 * something to sweep: the duplicate-key throw below, and the glossary
 * conformance test. A component that ever resolves through the merged catalog
 * turns every label edit into an app-wide edit, and is a regression even
 * though nothing would visibly break.
 *
 * The app declares the file paths at the merge site because the app is the one
 * place that knows them all — and a violation has to name a file a human can
 * open, not a key floating free of its owner.
 */

/** One feature's catalog, with the path a reader would have to open. */
export type CopySource = {
  readonly file: string;
  readonly entries: CopyCatalog;
};

/** Where a merged phrase came from, kept so a failure can name its file. */
export type MergedCopyEntry = {
  readonly text: LocalizedText;
  readonly file: string;
};

/** Key → phrase and provenance, across every registered catalog. */
export type MergedCopy = ReadonlyMap<string, MergedCopyEntry>;

/**
 * Merge every registered catalog, refusing a key two features both declare.
 *
 * The throw is at merge time, and the app's merge site is a module nothing in
 * the running app imports — so what a duplicate key actually breaks is
 * the application’s catalog check,
 * before the change can land. Deliberately not at browser module load: a
 * collision is an authoring mistake, and turning one into a blank screen for a
 * reader would be a worse wall than a red suite, not a stronger one. Key
 * prefixes are per feature (`orders.*`, `products.*`, `glossary.*`), so a
 * collision means a real mistake and not routine friction.
 */
export function mergeCopy(sources: readonly CopySource[]): MergedCopy {
  const merged = new Map<string, MergedCopyEntry>();
  for (const source of sources) {
    for (const [key, text] of Object.entries(source.entries)) {
      const existing = merged.get(key);
      if (existing) {
        throw new Error(
          `copy key "${key}" is declared twice — by ${existing.file} and by ${source.file}. Two features cannot own the same key; prefix each catalog with its own feature name.`,
        );
      }
      merged.set(key, { text, file: source.file });
    }
  }
  return merged;
}
