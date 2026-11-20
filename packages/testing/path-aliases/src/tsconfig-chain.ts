/**
 * The `extends` chain of one tsconfig, and the aliases it declares.
 *
 * A tsconfig rarely declares its own aliases: it extends a shared config that
 * does, sometimes through several files, sometimes through a package. So the
 * chain is walked here, by this package, before anything is asked about
 * aliases — a file nobody can parse then fails with this package's message and
 * a position rather than a vendor's, and a chain that revisits a config is a
 * refusal rather than a loop.
 *
 * The config that declares `paths` is the nearest one in the chain, and the
 * targets it declares resolve from that config's `baseUrl`, or from the
 * nearest `baseUrl` after it, or from its own directory.
 */

import { dirname, isAbsolute, resolve } from "node:path";
import type { AliasFileSystem } from "./alias-file-system.js";
import { parseJsonWithComments } from "./json-with-comments.js";

/** One config in the `extends` chain, and the directory its paths resolve from. */
export type TsconfigChainEntry = {
  readonly directory: string;
  readonly config: unknown;
};

/** The alias map one chain declares, and the directory its targets resolve from. */
export type DeclaredAliases = {
  readonly paths: Readonly<Record<string, unknown>>;
  readonly baseUrl: string;
};

// --- The chain -----------------------------------------------------------

/**
 * Every config the named tsconfig reaches through `extends`, nearest first.
 * A config reached twice is a refusal: an `extends` graph that revisits a file
 * has no one answer to which config declares what.
 */
export function readTsconfigChain(
  fileSystem: AliasFileSystem,
  tsconfigPath: string,
): readonly TsconfigChainEntry[] {
  requireTsconfigFile(fileSystem, tsconfigPath);
  const chain: TsconfigChainEntry[] = [];
  const queued = [tsconfigPath];
  const visited = new Set<string>();
  while (queued.length > 0) {
    const next = queued.shift();
    if (next === undefined) continue;
    const absolute = resolve(next);
    if (visited.has(absolute)) {
      throw new Error(
        `Dads path aliases found a circular tsconfig extends chain at ${absolute}.`,
      );
    }
    visited.add(absolute);
    const config = readTsconfigFile(fileSystem, absolute);
    chain.push({ directory: dirname(absolute), config });
    for (const extended of readExtends(config))
      queued.push(resolveExtendsPath(fileSystem, extended, absolute));
  }
  return chain;
}

function requireTsconfigFile(fileSystem: AliasFileSystem, path: string): void {
  if (!fileSystem.isFile(path)) {
    throw new Error(
      `Dads path aliases tsconfig is not a readable file: ${path}`,
    );
  }
}

/**
 * The package reads the tsconfig dialect itself — comments and trailing commas
 * included — so nothing here depends on the TypeScript compiler being
 * installed or on which version of it an adopter chose.
 */
function readTsconfigFile(
  fileSystem: AliasFileSystem,
  absolute: string,
): unknown {
  try {
    return parseJsonWithComments(fileSystem.readText(absolute));
  } catch (error: unknown) {
    throw new Error(
      `Unable to read Dads path aliases tsconfig ${absolute}: ${readFailureDetail(error)}`,
      { cause: error },
    );
  }
}

function readFailureDetail(error: unknown): string {
  return error instanceof Error ? error.message : "unknown read failure";
}

function readExtends(config: unknown): readonly string[] {
  if (!isRecord(config)) return [];
  const extended = config["extends"];
  if (typeof extended === "string") return [extended];
  if (
    Array.isArray(extended) &&
    extended.every((value) => typeof value === "string")
  )
    return extended;
  if (extended === undefined) return [];
  throw new Error(
    "Dads path aliases supports tsconfig extends only as a string or string array.",
  );
}

function resolveExtendsPath(
  fileSystem: AliasFileSystem,
  extended: string,
  childTsconfig: string,
): string {
  const childDirectory = dirname(childTsconfig);
  if (extended.startsWith(".") || isAbsolute(extended)) {
    const candidate = resolve(childDirectory, extended);
    if (fileSystem.isFile(candidate)) return candidate;
    const jsonCandidate = `${candidate}.json`;
    if (fileSystem.isFile(jsonCandidate)) return jsonCandidate;
    throw new Error(
      `Dads path aliases cannot resolve tsconfig extends ${extended} from ${childTsconfig}.`,
    );
  }
  for (const candidate of [extended, `${extended}/tsconfig.json`]) {
    const resolved = fileSystem.resolvePackage(candidate, childTsconfig);
    if (resolved !== undefined) return resolved;
  }
  throw new Error(
    `Dads path aliases cannot resolve tsconfig package ${extended} from ${childTsconfig}.`,
  );
}

// --- What the chain declares ---------------------------------------------

/**
 * The aliases the chain declares, and where their targets resolve from. A
 * chain that declares none answers with an empty map, which the caller refuses
 * in its own words.
 */
export function readDeclaredAliases(
  chain: readonly TsconfigChainEntry[],
  tsconfigPath: string,
): DeclaredAliases {
  const owner = chain.find((entry) => hasPaths(entry.config));
  if (owner === undefined) {
    return { paths: {}, baseUrl: dirname(tsconfigPath) };
  }
  return { paths: readPaths(owner.config), baseUrl: baseUrlFrom(chain, owner) };
}

function baseUrlFrom(
  chain: readonly TsconfigChainEntry[],
  owner: TsconfigChainEntry,
): string {
  for (const entry of chain.slice(chain.indexOf(owner))) {
    const baseUrl = readBaseUrl(entry.config);
    if (baseUrl !== undefined) return resolve(entry.directory, baseUrl);
  }
  return owner.directory;
}

function hasPaths(config: unknown): boolean {
  const paths = readPaths(config);
  return Object.keys(paths).length > 0;
}

function readPaths(config: unknown): Readonly<Record<string, unknown>> {
  const paths = readCompilerOptions(config)?.["paths"];
  return isRecord(paths) ? paths : {};
}

function readBaseUrl(config: unknown): string | undefined {
  const baseUrl = readCompilerOptions(config)?.["baseUrl"];
  return typeof baseUrl === "string" && baseUrl.length > 0
    ? baseUrl
    : undefined;
}

function readCompilerOptions(
  config: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(config)) return undefined;
  const compilerOptions = config["compilerOptions"];
  return isRecord(compilerOptions) ? compilerOptions : undefined;
}

/** The one record guard this package uses, so nothing declares a second. */
export function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
