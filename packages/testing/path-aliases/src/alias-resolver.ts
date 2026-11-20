/**
 * One tsconfig's path aliases, resolved to files.
 *
 * The resolver is built once, from one named tsconfig, and every alias shape
 * it cannot honor exactly is refused while it is being built rather than
 * quietly resolving less at run time. What it answers is an absolute path to a
 * file that exists, or `null` for a specifier it does not own — a bare
 * specifier, an absolute path, or an alias whose target names nothing.
 *
 * Every file question goes through the `AliasFileSystem` port, so the same
 * rules run over a directory on disk and over a map in memory.
 */

import { isAbsolute, resolve } from "node:path";
import type { AliasFileSystem } from "./alias-file-system.js";
import {
  isRecord,
  readDeclaredAliases,
  readTsconfigChain,
} from "./tsconfig-chain.js";

const supportedExtensions = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".mts",
  ".mjs",
  ".cts",
  ".cjs",
  ".css",
  ".scss",
  ".less",
] as const;

export type AliasResolverOptions = {
  /** Absolute paths are preferred. Relative paths resolve from process.cwd(). */
  readonly tsconfig: string;
  /** Where the resolver reads. `nodeFileSystem` is the disk. */
  readonly fileSystem: AliasFileSystem;
};

/** Answers an absolute file path, or `null` for a specifier it does not own. */
export type AliasResolver = (specifier: string) => string | null;

type AliasMapping = {
  readonly pattern: string;
  readonly target: string;
};

export function createAliasResolver(
  options: AliasResolverOptions,
): AliasResolver {
  const { fileSystem } = options;
  const absoluteTsconfig = resolve(
    process.cwd(),
    requireTsconfigOption(options.tsconfig),
  );
  const chain = readTsconfigChain(fileSystem, absoluteTsconfig);
  const declared = readDeclaredAliases(chain, absoluteTsconfig);
  const entries = Object.entries(declared.paths);
  if (entries.length === 0) {
    throw new Error(
      `Dads path aliases tsconfig ${absoluteTsconfig} does not declare or inherit compilerOptions.paths.`,
    );
  }
  const mappings = entries.map(([pattern, targets]) =>
    parseAliasMapping(pattern, targets, absoluteTsconfig),
  );
  return (specifier: string): string | null =>
    resolveSpecifier(fileSystem, mappings, declared.baseUrl, specifier);
}

function requireTsconfigOption(tsconfig: string): string {
  if (tsconfig.trim().length === 0) {
    throw new Error("Dads path aliases requires a non-empty tsconfig path.");
  }
  return tsconfig;
}

// --- The alias map -------------------------------------------------------

/** One usable target, or none: a target list of any other shape is refused. */
function parseAliasMapping(
  pattern: string,
  targets: unknown,
  tsconfig: string,
): AliasMapping {
  const target = onlyTarget(targets);
  if (target === undefined) {
    throw new Error(
      `Dads path alias ${pattern} in ${tsconfig} must have exactly one target.`,
    );
  }
  const patternStars = countStars(pattern);
  const targetStars = countStars(target);
  if (patternStars > 1 || targetStars !== patternStars) {
    throw new Error(
      `Dads path alias ${pattern} in ${tsconfig} must use zero or one matching wildcard.`,
    );
  }
  return { pattern, target };
}

function onlyTarget(targets: unknown): string | undefined {
  if (!Array.isArray(targets) || targets.length !== 1) return undefined;
  const first: unknown = targets[0];
  return typeof first === "string" ? first : undefined;
}

function countStars(value: string): number {
  let stars = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "*") stars += 1;
  }
  return stars;
}

// --- Resolving one specifier ---------------------------------------------

function resolveSpecifier(
  fileSystem: AliasFileSystem,
  mappings: readonly AliasMapping[],
  baseUrl: string,
  rawSpecifier: string,
): string | null {
  if (shouldDefer(rawSpecifier)) return null;
  const specifier = rawSpecifier.replace(/\?\S*$/, "");
  for (const mapping of mappings) {
    const wildcard = matchAlias(mapping.pattern, specifier);
    if (wildcard === undefined) continue;
    const candidate = resolve(baseUrl, mapping.target.replace("*", wildcard));
    const resolved = resolveCandidate(fileSystem, candidate);
    if (resolved !== null) return resolved;
  }
  return null;
}

/** An absolute specifier is the caller's own path, and stays theirs to resolve. */
function shouldDefer(specifier: string): boolean {
  return specifier.startsWith("/") || isAbsolute(specifier);
}

function matchAlias(pattern: string, specifier: string): string | undefined {
  const wildcardIndex = pattern.indexOf("*");
  if (wildcardIndex < 0) return pattern === specifier ? "" : undefined;
  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix))
    return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

/**
 * What one alias target names, in the order a target can name it: the file
 * itself, the entry point of a package directory, the file under a supported
 * extension or an `index` inside it, and finally the source file behind a
 * specifier written with an explicit extension.
 */
function resolveCandidate(
  fileSystem: AliasFileSystem,
  candidate: string,
): string | null {
  if (fileSystem.isFile(candidate)) return resolve(candidate);
  const entry = packageEntryFile(fileSystem, candidate);
  if (entry !== null) return entry;
  const supported = findSupportedFile(fileSystem, candidate);
  if (supported !== null) return supported;
  return explicitExtensionSource(fileSystem, candidate);
}

function findSupportedFile(
  fileSystem: AliasFileSystem,
  candidate: string,
): string | null {
  if (fileSystem.isFile(candidate)) return resolve(candidate);
  for (const extension of supportedExtensions) {
    const withExtension = `${candidate}${extension}`;
    if (fileSystem.isFile(withExtension)) return resolve(withExtension);
    const indexFile = resolve(candidate, `index${extension}`);
    if (fileSystem.isFile(indexFile)) return indexFile;
  }
  return null;
}

/** `@app/source.js` finds `src/source.ts`, the file the extension stands for. */
function explicitExtensionSource(
  fileSystem: AliasFileSystem,
  candidate: string,
): string | null {
  const extension = supportedExtensions.find((one) => candidate.endsWith(one));
  if (extension === undefined) return null;
  return findSupportedFile(fileSystem, candidate.slice(0, -extension.length));
}

// --- A package directory -------------------------------------------------

/**
 * The entry point of a package directory an alias points at: the first of
 * `exports`, `module`, and `main` that names a file which exists. A manifest
 * that cannot be read is no manifest at all, so resolution falls through to
 * the extension and index probes.
 */
function packageEntryFile(
  fileSystem: AliasFileSystem,
  directory: string,
): string | null {
  const manifest = readPackageManifest(
    fileSystem,
    resolve(directory, "package.json"),
  );
  if (manifest === undefined) return null;
  const fields = [packageEntry(manifest), manifest["module"], manifest["main"]];
  for (const field of fields) {
    if (typeof field !== "string") continue;
    const entry = resolve(directory, field);
    if (fileSystem.isFile(entry)) return entry;
  }
  return null;
}

function readPackageManifest(
  fileSystem: AliasFileSystem,
  packageJsonPath: string,
): Readonly<Record<string, unknown>> | undefined {
  if (!fileSystem.isFile(packageJsonPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(fileSystem.readText(packageJsonPath));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The entry point a package declares for this resolver: `exports["."]` as a
 * string, or its `import` condition, or its `default` condition. Anything else
 * is absent, which leaves `module` and `main` to answer.
 */
function packageEntry(
  manifest: Readonly<Record<string, unknown>>,
): string | undefined {
  const exported = manifest["exports"];
  if (typeof exported === "string") return exported;
  if (!isRecord(exported)) return undefined;
  const root = exported["."];
  if (typeof root === "string") return root;
  if (!isRecord(root)) return undefined;
  return firstString([root["import"], root["default"]]);
}

function firstString(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return undefined;
}
