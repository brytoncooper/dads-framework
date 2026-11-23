import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isRecord, isUnknownArray } from "../parse-guards.js";
import { describeError } from "./describe-error.js";
import type { InitUnsupported } from "./infer-testing-manifest.js";
import { stripJsonComments } from "./strip-json-comments.js";
import { workspaceRelative } from "./workspace-relative-path.js";

/**
 * What each candidate directory declares about itself: the scripts a task could
 * run, and the two edges that make one package depend on another — a workspace
 * dependency in `package.json`, and a project reference in `tsconfig.json`.
 * Both edges are read only to widen the fallback, never to prove impact.
 */

export type WorkspacePackage = {
  readonly directory: string;
  readonly name?: string;
  readonly scripts: Readonly<Record<string, string>>;
  /** Names of other inventoried packages this package declares a dependency on. */
  readonly workspaceDependencies: readonly string[];
  /** Directories of other inventoried packages this package's tsconfig references. */
  readonly tsconfigReferences: readonly string[];
  /** False when `package.json` could not be read; the package declares no tasks. */
  readonly packageJsonReadable: boolean;
  readonly unsupported: readonly InitUnsupported[];
};

type ReadPackageJson = {
  readonly name?: string;
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencyNames: readonly string[];
};

const dependencyFields = ["dependencies", "devDependencies", "peerDependencies"];

export function readWorkspacePackages(
  workspaceRoot: string,
  directories: readonly string[],
): readonly WorkspacePackage[] {
  const read = directories.map((directory) => readOnePackage(workspaceRoot, directory));
  const knownNames = new Set(
    read.map((entry) => entry.declared?.name).filter((name): name is string => name !== undefined),
  );
  const knownDirectories = new Set(read.map((entry) => entry.directory));

  return read.map((entry) => {
    const unsupported = [...entry.unsupported];
    const declared = entry.declared;
    const references = resolveTsconfigReferences(workspaceRoot, entry.directory, knownDirectories, unsupported);
    const name = declared?.name;
    return {
      directory: entry.directory,
      ...(name === undefined ? {} : { name }),
      scripts: declared?.scripts ?? {},
      workspaceDependencies: (declared?.dependencyNames ?? []).filter(
        (dependency) => dependency !== name && knownNames.has(dependency),
      ),
      tsconfigReferences: references,
      packageJsonReadable: declared !== undefined,
      unsupported,
    };
  });
}

function readOnePackage(
  workspaceRoot: string,
  directory: string,
): {
  readonly directory: string;
  readonly declared: ReadPackageJson | undefined;
  readonly unsupported: readonly InitUnsupported[];
} {
  const packageJsonPath = join(absoluteDirectory(workspaceRoot, directory), "package.json");
  let text: string;
  try {
    text = readFileSync(packageJsonPath, "utf8");
  } catch (error: unknown) {
    return {
      directory,
      declared: undefined,
      unsupported: [
        {
          subject: joinRelative(directory, "package.json"),
          message: `unreadable package.json (${describeError(error)}).`,
        },
      ],
    };
  }

  try {
    return { directory, declared: readPackageJson(text), unsupported: [] };
  } catch (error: unknown) {
    return {
      directory,
      declared: undefined,
      unsupported: [
        {
          subject: joinRelative(directory, "package.json"),
          message: `${describeError(error)}.`,
        },
      ],
    };
  }
}

/**
 * Reads only the fields an inferred manifest depends on, and refuses a wrong
 * type rather than coercing it: a `scripts` value that is not a string would
 * otherwise become a task that cannot run.
 */
function readPackageJson(text: string): ReadPackageJson {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error("package.json must be an object");
  const declaredName = readDeclaredName(parsed);
  return {
    ...(declaredName === undefined ? {} : { name: declaredName }),
    scripts: readDeclaredScripts(parsed),
    dependencyNames: readDeclaredDependencyNames(parsed),
  };
}

function readDeclaredName(parsed: Readonly<Record<string, unknown>>): string | undefined {
  const declaredName = parsed["name"];
  if (declaredName === undefined) return undefined;
  if (typeof declaredName !== "string") {
    throw new Error("package.json name must be a string");
  }
  return declaredName;
}

/** A command that is not a string would become a task that cannot run. */
function readDeclaredScripts(parsed: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
  const declaredScripts = parsed["scripts"];
  if (declaredScripts === undefined) return {};
  if (!isRecord(declaredScripts)) {
    throw new Error("package.json scripts must be an object");
  }
  const scripts: Record<string, string> = {};
  for (const [scriptName, command] of Object.entries(declaredScripts)) {
    if (typeof command !== "string") {
      throw new Error(`package.json scripts.${scriptName} must be a string`);
    }
    scripts[scriptName] = command;
  }
  return scripts;
}

/** Every dependency field contributes names; which field it came from does not matter. */
function readDeclaredDependencyNames(parsed: Readonly<Record<string, unknown>>): readonly string[] {
  const dependencyNames: string[] = [];
  for (const field of dependencyFields) {
    const declared = parsed[field];
    if (declared === undefined) continue;
    if (!isRecord(declared)) {
      throw new Error(`package.json ${field} must be an object`);
    }
    dependencyNames.push(...Object.keys(declared));
  }
  return dependencyNames;
}

/**
 * TypeScript project references name a tsconfig, not a package, so a reference
 * only becomes a dependency edge when it resolves to a directory this inventory
 * already knows. Anything else is named in the report rather than dropped.
 */
function resolveTsconfigReferences(
  workspaceRoot: string,
  directory: string,
  knownDirectories: ReadonlySet<string>,
  unsupported: InitUnsupported[],
): readonly string[] {
  const tsconfigPath = join(absoluteDirectory(workspaceRoot, directory), "tsconfig.json");
  if (!existsSync(tsconfigPath)) return [];
  const declared = readDeclaredReferences(tsconfigPath, directory, unsupported);

  const references: string[] = [];
  for (const entry of declared) {
    const referenced = referencedPackageDirectory({
      workspaceRoot,
      tsconfigPath,
      directory,
      entry,
      knownDirectories,
      unsupported,
    });
    if (referenced === undefined) continue;
    if (!references.includes(referenced)) references.push(referenced);
  }
  return references;
}

/**
 * A tsconfig this reader cannot understand contributes no edges: the reason is
 * named in the report rather than raised, because a workspace may hold a
 * tsconfig no one asked `dad-test` to read.
 */
function readDeclaredReferences(
  tsconfigPath: string,
  directory: string,
  unsupported: InitUnsupported[],
): readonly unknown[] {
  const subject = joinRelative(directory, "tsconfig.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(readFileSync(tsconfigPath, "utf8")));
  } catch (error: unknown) {
    unsupported.push({
      subject,
      message: `unreadable tsconfig.json (${describeError(error)}).`,
    });
    return [];
  }
  if (!isRecord(parsed)) {
    unsupported.push({ subject, message: "tsconfig.json must be an object." });
    return [];
  }

  const declared = parsed["references"];
  if (declared === undefined) return [];
  if (isUnknownArray(declared)) return declared;
  unsupported.push({ subject, message: "references must be an array." });
  return [];
}

/** One reference becomes an edge only when it names a directory this inventory knows. */
function referencedPackageDirectory(request: {
  readonly workspaceRoot: string;
  readonly tsconfigPath: string;
  readonly directory: string;
  readonly entry: unknown;
  readonly knownDirectories: ReadonlySet<string>;
  readonly unsupported: InitUnsupported[];
}): string | undefined {
  const subject = joinRelative(request.directory, "tsconfig.json");
  const path = isRecord(request.entry) ? request.entry["path"] : undefined;
  if (typeof path !== "string") {
    request.unsupported.push({
      subject,
      message: "every reference must declare a string path.",
    });
    return undefined;
  }
  const referenced = referencedDirectory(request.workspaceRoot, dirname(request.tsconfigPath), path);
  if (request.knownDirectories.has(referenced)) return referenced;
  request.unsupported.push({
    subject,
    message: `reference ${path} does not name a workspace package.`,
  });
  return undefined;
}

/** A reference may name a tsconfig file or the directory that holds one. */
function referencedDirectory(workspaceRoot: string, fromDirectory: string, referencePath: string): string {
  const resolved = resolve(fromDirectory, referencePath);
  const namesFile = existsSync(resolved) ? statSync(resolved).isFile() : resolved.endsWith(".json");
  return workspaceRelative(workspaceRoot, namesFile ? dirname(resolved) : resolved);
}

function absoluteDirectory(workspaceRoot: string, directory: string): string {
  return directory === "." ? workspaceRoot : join(workspaceRoot, directory);
}

function joinRelative(directory: string, file: string): string {
  return directory === "." ? file : `${directory}/${file}`;
}
