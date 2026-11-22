/** Render a `.ts`/`.js` or `.zed` access schema as a deterministic ASCII hierarchy tree. */

import { resolve } from "node:path";
import {
  compileAccessFromIr,
  formatAccessTree,
  parseZed,
} from "@dads-framework/access";
import { loadAccessSource } from "./access-source-loader.js";
import { readZedFile } from "./access-zed-io.js";

export type RenderAccessTreeOptions = {
  readonly inputPath: string;
  readonly cwd?: string;
};

export type AccessTreeResult = {
  readonly inputPath: string;
  readonly definitionCount: number;
  readonly definitions: readonly string[];
  readonly tree: string;
};

/**
 * Load an access schema from a `.ts`/`.mts`/`.js`/`.mjs` module or `.zed`
 * schema file and render its deterministic ASCII hierarchy tree via
 * `formatAccessTree`.
 */
export async function renderAccessTree(
  options: RenderAccessTreeOptions,
): Promise<AccessTreeResult> {
  const loaded = await loadAccessSource(options.inputPath, options.cwd);
  const tree = formatAccessTree(loaded.model);

  return {
    inputPath: loaded.path,
    definitionCount: loaded.definitions.length,
    definitions: loaded.definitions.map((definition) => definition.wireName),
    tree,
  };
}

/**
 * Read a `.zed` schema file, parse it into Dads access IR, lower it into an
 * `AccessModel`, and render the hierarchy tree via `formatAccessTree`.
 */
export function renderZedAccessTree(
  options: RenderAccessTreeOptions,
): AccessTreeResult {
  const baseDirectory = options.cwd ?? process.cwd();
  const inputPath = resolve(baseDirectory, options.inputPath);
  const source = readZedFile(inputPath);
  const definitions = parseZed(source);
  const model = compileAccessFromIr(definitions);
  const tree = formatAccessTree(model);

  return {
    inputPath,
    definitionCount: definitions.length,
    definitions: definitions.map((definition) => definition.wireName),
    tree,
  };
}
