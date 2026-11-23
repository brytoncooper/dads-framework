/**
 * The provider that answers from the disk the process is running on.
 *
 * It is the whole of this package's contact with `node:fs` and `node:module`:
 * every rule about aliases, chains, and refusals is written against the port
 * instead, so a resolver can be run without a disk at all.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import type { AliasFileSystem } from "./alias-file-system.js";

export const nodeFileSystem: AliasFileSystem = {
  isFile: (path: string): boolean => {
    try {
      return existsSync(path) && statSync(path).isFile();
    } catch {
      return false;
    }
  },
  readText: (path: string): string => readFileSync(path, "utf8"),
  resolvePackage: (specifier: string, fromFile: string): string | undefined => {
    try {
      return createRequire(fromFile).resolve(specifier);
    } catch {
      return undefined;
    }
  },
};
