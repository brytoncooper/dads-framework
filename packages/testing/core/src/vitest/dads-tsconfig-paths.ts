/**
 * The Vite binding of the Dads alias resolver.
 *
 * Every rule about aliases — which config declares them, what a target may
 * look like, which file a specifier names, and every refusal — belongs to
 * `@dads-framework/testing/path-aliases` and is proven there against two file systems.
 * What is left here is the one thing that is Vite's: an ordinary plugin that
 * runs before Vite's own resolution and answers `resolveId` with the path the
 * resolver found, or `null`.
 */

import { createAliasResolver, nodeFileSystem, type AliasResolver } from "../path-aliases/index.js";
import { isRecord } from "../parse-guards.js";
import type { Plugin } from "vite";

export type DadsTsconfigPathsOptions = {
  /** Absolute paths are preferred. Relative paths resolve from process.cwd(). */
  readonly tsconfig: string;
};

export function dadsTsconfigPaths(options: DadsTsconfigPathsOptions): Plugin {
  const untrustedOptions: unknown = options;
  const resolveTsconfigPath: AliasResolver = createAliasResolver({
    tsconfig: readRequiredTsconfigOption(untrustedOptions),
    fileSystem: nodeFileSystem,
  });
  return {
    name: "dads-tsconfig-paths",
    enforce: "pre",
    resolveId(specifier) {
      return resolveTsconfigPath(specifier);
    },
  };
}

/** The plugin is called from JavaScript configs, so the options are untrusted. */
function readRequiredTsconfigOption(options: unknown): string {
  if (!isRecord(options)) {
    throw new Error("dadsTsconfigPaths requires a non-empty tsconfig path.");
  }
  const tsconfig = options["tsconfig"];
  if (typeof tsconfig !== "string" || tsconfig.trim().length === 0) {
    throw new Error("dadsTsconfigPaths requires a non-empty tsconfig path.");
  }
  return tsconfig;
}
