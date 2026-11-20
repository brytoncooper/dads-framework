/**
 * The file system an alias resolver is written against.
 *
 * Resolving a TypeScript path alias asks a file system three questions and no
 * others: is this path a readable file, what text does it hold, and where does
 * a package name resolve to from this file. Naming those three is what makes
 * the boundary a wall rather than a folder name — the same resolver runs over
 * a directory on disk and over a map held in memory, and both are put through
 * one conformance suite.
 *
 * The port is deliberately smaller than `node:fs`. Nothing here lists a
 * directory, watches a path, or writes: an alias resolver that could do any of
 * those would be answering a different question.
 */

export type AliasFileSystem = {
  /** True when the path names a readable file. A directory is never a file. */
  readonly isFile: (path: string) => boolean;
  /** The file's text. Throws when the path names no readable file. */
  readonly readText: (path: string) => string;
  /**
   * The absolute path a package specifier resolves to when it is required
   * from `fromFile`, or `undefined` when nothing there answers to that name.
   */
  readonly resolvePackage: (
    specifier: string,
    fromFile: string,
  ) => string | undefined;
};
