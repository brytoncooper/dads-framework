/**
 * What pure logic returns instead of an English sentence.
 *
 * A template reading "Remove ROLE from COMPANY" is a sentence assembled in one
 * particular language.
 * Spanish moves the article, the adjective and the `de` contraction, so the
 * template is wrong there in a way no translation of its pieces can fix. A
 * descriptor names WHICH sentence and WHAT fills it, and the component that
 * renders it resolves the whole thing in one piece — so `logic/` stays pure and
 * its tests assert on the descriptor rather than on English, which is a
 * stronger test than the one it replaces.
 */

/** What fills a sentence's slots — including another sentence. */
export type CopyVars = Readonly<Record<string, string | number | CopyDescriptor>>;

export type CopyDescriptor<Key extends string = string> = {
  readonly key: Key;
  readonly vars?: CopyVars;
  /** Present when the sentence pluralizes; selects `_one` / `_other`. */
  readonly count?: number;
};

/**
 * Name a sentence and what fills it.
 *
 * Absent arguments are left off the object rather than set to `undefined`, so a
 * logic test can assert `toEqual({ key: "orders.empty" })` and read as what it
 * means.
 */
export function copy<Key extends string>(key: Key, vars?: CopyVars, count?: number): CopyDescriptor<Key> {
  return {
    key,
    ...(vars === undefined ? {} : { vars }),
    ...(count === undefined ? {} : { count }),
  };
}

/** True for a descriptor, false for a bare key or an interpolated value. */
export function isCopyDescriptor(value: unknown): value is CopyDescriptor {
  if (typeof value !== "object" || value === null) return false;
  if (!("key" in value)) return false;
  return typeof value.key === "string";
}
