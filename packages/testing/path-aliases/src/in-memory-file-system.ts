/**
 * A provider that binds no disk, so the seam has a second implementation.
 *
 * It is a map of absolute paths to text. Everything a resolver asks of a file
 * system is answered from that map: a path is a file when the map holds it, a
 * read is a lookup, and a package resolves by the walk Node itself does —
 * `node_modules/<specifier>` in this directory, then its parent, and up.
 *
 * It exists to be run through the conformance suite beside the Node provider.
 * A boundary with one implementation is a folder name, and Dad's test is the
 * stand-in.
 */

import { dirname, resolve } from "node:path";
import type { AliasFileSystem } from "./alias-file-system.js";

/** A file system over `files`, keyed by absolute path. */
export function inMemoryFileSystem(
  files: Readonly<Record<string, string>>,
): AliasFileSystem {
  const byPath = new Map(
    Object.entries(files).map(([path, text]) => [resolve(path), text]),
  );
  return {
    isFile: (path: string): boolean => byPath.has(resolve(path)),
    readText: (path: string): string => readOrRefuse(byPath, path),
    resolvePackage: (specifier: string, fromFile: string): string | undefined =>
      findInNodeModules(byPath, specifier, fromFile),
  };
}

function readOrRefuse(byPath: ReadonlyMap<string, string>, path: string) {
  const text = byPath.get(resolve(path));
  if (text === undefined) {
    throw new Error(`This in-memory file system holds no file at ${path}.`);
  }
  return text;
}

/** Node's own lookup, over the map: `node_modules/<specifier>` upwards. */
function findInNodeModules(
  byPath: ReadonlyMap<string, string>,
  specifier: string,
  fromFile: string,
): string | undefined {
  let directory = dirname(resolve(fromFile));
  for (;;) {
    const candidate = resolve(directory, "node_modules", specifier);
    if (byPath.has(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
