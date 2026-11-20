/**
 * The suite every file system an alias resolver runs over is put through.
 *
 * A file system here is one capability — is this a file, what does it say,
 * where does this package live — and a capability with one implementation has
 * never been tested as a capability. So the laws are written once, here,
 * against the port, and every provider is put through them: the Node provider,
 * the in-memory stand-in, and whatever a third one turns out to be.
 *
 * Each law builds a tsconfig chain and its files through the provider under
 * test and then asks the resolver a question it already knows the answer to.
 * A run answers with findings rather than throwing, so a caller sees every law
 * a provider broke instead of only the first. The laws themselves are the
 * table in `alias-resolver-conformance-cases.ts`, and `aliasResolverConformanceLaws`
 * names them, so a caller can give each law a test of its own and let its own
 * runner name the one that broke.
 */

import { resolve } from "node:path";
import type { AliasFileSystem } from "./alias-file-system.js";
import { createAliasResolver, type AliasResolver } from "./alias-resolver.js";
import {
  aliasRefusalCases,
  aliasResolutionCases,
  type FixturePath,
  type RefusalCase,
  type Resolution,
  type ResolutionCase,
} from "./alias-resolver-conformance-cases.js";

/** Builds a file system serving exactly the given absolute paths. */
export type AliasFileSystemFactory = (
  files: Readonly<Record<string, string>>,
) => AliasFileSystem;

/** What the suite is run against. */
export type AliasResolverConformanceSubject = {
  /** An absolute directory every fixture in one run is built under. */
  readonly root: string;
  readonly fileSystem: AliasFileSystemFactory;
};

/** One law a provider broke, and where. */
export type AliasResolverConformanceFinding = {
  readonly case: string;
  readonly law: string;
  readonly detail: string;
};

/** The law a provider breaks when a valid case cannot build a resolver at all. */
const buildsAResolver = "builds-a-resolver";

/** The law a blank tsconfig option is refused by, before any file is read. */
const refusesBlankTsconfig = "refuses-blank-tsconfig";

/**
 * Every law this suite holds a provider to, named once each and in the order a
 * run reaches them, so a caller can hold a provider to one law at a time rather
 * than only to the whole list at once.
 */
export function aliasResolverConformanceLaws(): readonly string[] {
  return [
    ...new Set([
      buildsAResolver,
      ...aliasResolutionCases().flatMap((declared) =>
        declared.resolutions.map((one) => one.law),
      ),
      ...aliasRefusalCases.map((declared) => declared.law),
      refusesBlankTsconfig,
    ]),
  ];
}

/** Every law the given provider broke; an empty list is conformance. */
export function runAliasResolverConformance(
  subject: AliasResolverConformanceSubject,
): readonly AliasResolverConformanceFinding[] {
  return [
    ...aliasResolutionCases().flatMap((declared) =>
      checkResolutions(subject, declared),
    ),
    ...aliasRefusalCases.flatMap((declared) => checkRefusal(subject, declared)),
    ...checkBlankTsconfig(subject),
  ];
}

// --- Aliases that resolve -------------------------------------------------

function checkResolutions(
  subject: AliasResolverConformanceSubject,
  declared: ResolutionCase,
): readonly AliasResolverConformanceFinding[] {
  const at = fixturePath(subject, declared.name);
  let built;
  try {
    built = createAliasResolver({
      tsconfig: at(declared.tsconfig),
      fileSystem: subject.fileSystem(absoluteFiles(at, declared.files)),
    });
  } catch (error: unknown) {
    return [finding(declared.name, buildsAResolver, reason(error))];
  }
  const resolver = built;
  return declared.resolutions.flatMap((one) =>
    checkOneResolution(resolver, at, declared.name, one),
  );
}

function checkOneResolution(
  resolver: AliasResolver,
  at: FixturePath,
  name: string,
  declared: Resolution,
): readonly AliasResolverConformanceFinding[] {
  const specifier =
    declared.asAbsolutePath === true
      ? at(declared.specifier)
      : declared.specifier;
  const expected = declared.to === null ? null : at(declared.to);
  let answer: string | null;
  try {
    answer = resolver(specifier);
  } catch (error: unknown) {
    return [
      finding(name, declared.law, `${specifier} threw: ${reason(error)}`),
    ];
  }
  if (answer === expected) return [];
  return [
    finding(
      name,
      declared.law,
      `${specifier} answered ${describe(answer)}, expected ${describe(expected)}`,
    ),
  ];
}

// --- Configurations that are refused --------------------------------------

function checkRefusal(
  subject: AliasResolverConformanceSubject,
  declared: RefusalCase,
): readonly AliasResolverConformanceFinding[] {
  const at = fixturePath(subject, declared.name);
  const expected = declared.message(at);
  try {
    createAliasResolver({
      tsconfig: at(declared.tsconfig),
      fileSystem: subject.fileSystem(absoluteFiles(at, declared.files)),
    });
  } catch (error: unknown) {
    return refusalFindings(declared.name, declared.law, expected, error);
  }
  return [
    finding(
      declared.name,
      declared.law,
      `built a resolver instead of refusing with "${expected}"`,
    ),
  ];
}

/** A blank option is refused before any file system is asked anything. */
function checkBlankTsconfig(
  subject: AliasResolverConformanceSubject,
): readonly AliasResolverConformanceFinding[] {
  const expected = "Dads path aliases requires a non-empty tsconfig path.";
  const name = "a-blank-tsconfig-option";
  return ["", "   "].flatMap((tsconfig) => {
    try {
      createAliasResolver({ tsconfig, fileSystem: subject.fileSystem({}) });
    } catch (error: unknown) {
      return refusalFindings(name, refusesBlankTsconfig, expected, error);
    }
    return [
      finding(
        name,
        refusesBlankTsconfig,
        `built a resolver from "${tsconfig}"`,
      ),
    ];
  });
}

function refusalFindings(
  name: string,
  law: string,
  expected: string,
  error: unknown,
): readonly AliasResolverConformanceFinding[] {
  const said = reason(error);
  if (said.includes(expected)) return [];
  return [finding(name, law, `refused with "${said}", expected "${expected}"`)];
}

// --- Shared --------------------------------------------------------------

function fixturePath(
  subject: AliasResolverConformanceSubject,
  name: string,
): FixturePath {
  return (relative: string): string => resolve(subject.root, name, relative);
}

function absoluteFiles(
  at: FixturePath,
  files: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(files).map(([path, text]) => [at(path), text]),
  );
}

function finding(
  name: string,
  law: string,
  detail: string,
): AliasResolverConformanceFinding {
  return { case: name, law, detail };
}

function describe(path: string | null): string {
  return path === null ? "null" : path;
}

function reason(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "a value that was not an Error";
}
