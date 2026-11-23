/**
 * The package graph: what every package declares, and what its text does.
 *
 * Three sources joined once per run. `dads.project.json` says the name, the
 * root, the kind, and the dependencies a package is allowed. Each package's
 * `package.json` says what it actually installs, what it publishes, and which
 * peers it forces on a consumer. The text of its production sources says what
 * it imports. A signal that reads packages reads this and nothing else, so the
 * same edge is never counted two different ways by two different signals.
 *
 * Where a workspace has no `dads.project.json`, the packages are the
 * `package.json` files under the workspace globs, and their kinds are unknown.
 * A signal that needs a kind reports that it was not measured rather than
 * guessing one: an undeclared package is not a `core` package, it is a package
 * nobody has said anything about.
 *
 * A package's production sources are the modules under its `src/`, which is the
 * same set `check-dependency-boundaries.mjs` gates. That is a convention, and a
 * package that keeps its source elsewhere reads as having none rather than
 * having the whole repository. Imports are read from text, by a scanner that
 * knows three things: comments are not code, a specifier inside a string is not
 * an import, and a module a template literal renders is text this package emits
 * rather than a module this package reaches.
 */

import { isRecord, isString } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";
import { stripCommentsFromLine, type StripState } from "./counted-lines.js";
import { readCodeSkeleton } from "./top-level-declarations.js";

const PROJECT_FILE = "dads.project.json";
const MANIFEST_NAME = "package.json";
const MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];
const NOT_PRODUCTION = ["/type-tests/", "/test-support/", "/__tests__/"];
const TEST_SUFFIXES = [".test.ts", ".test.tsx", ".test.mjs", ".test.js"];
const CLEAN_STRIP: StripState = { block: false, literal: undefined };

/** `from "x"`, `import "x"`, `import("x")`, `require("x")`, with the specifier. */
const SPECIFIER_WITH_TEXT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(["'])([^"'\n]*)\1/g;
/** The same shapes in a skeleton, where every string has been emptied. */
const SPECIFIER_IN_SKELETON = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(["'])\1/g;

/** Peers that constrain the runtime rather than name a library. */
const RUNTIME_PEERS = ["node", "npm", "pnpm", "yarn", "bun", "@types/node"];

/** One import a production source shows, with the place a reader can open. */
export type PackageImport = {
  readonly path: string;
  readonly line: number;
  readonly specifier: string;
  /** The bare package the specifier names, or `undefined` when it is relative. */
  readonly module: string | undefined;
};

/** What one `package.json` says, reduced to the facts a signal asks for. */
export type PackageManifestFacts = {
  readonly path: string;
  readonly name: string | undefined;
  readonly dependencies: readonly string[];
  readonly peerDependencies: readonly string[];
  readonly requiredPeerDependencies: readonly string[];
  readonly runtimePeers: readonly string[];
};

/** One package, as declared and as its own text behaves. */
export type GraphPackage = {
  readonly name: string;
  readonly root: string;
  readonly kind: string | undefined;
  readonly allowedDependencies: readonly string[];
  readonly manifest: PackageManifestFacts | undefined;
  readonly sources: readonly string[];
  readonly imports: readonly PackageImport[];
};

export type PackageGraph = {
  /** True when `dads.project.json` declares the packages and their kinds. */
  readonly declared: boolean;
  readonly packages: readonly GraphPackage[];
  /** Every `package.json` in the tree, declared as a package or not. */
  readonly manifests: readonly PackageManifestFacts[];
  readonly workspaceNames: ReadonlySet<string>;
};

const GRAPHS = new WeakMap<DoctorContext, PackageGraph>();

/** The graph for this run, built once and kept against the context. */
export function readPackageGraph(context: DoctorContext): PackageGraph {
  const known = GRAPHS.get(context);
  if (known !== undefined) return known;
  const graph = buildPackageGraph(context);
  GRAPHS.set(context, graph);
  return graph;
}

function buildPackageGraph(context: DoctorContext): PackageGraph {
  const manifests = readManifestFacts(context);
  const declared = context.packages();
  const workspaceNames = new Set(
    declared.map((entry) => entry.name).concat(manifests.flatMap((entry) => (entry.name ? [entry.name] : []))),
  );
  const byRoot = new Map(manifests.map((entry) => [manifestRootOf(entry), entry]));
  const packages = declared.map((entry) =>
    joinPackage(context, entry.name, entry.root, {
      kind: entry.kind,
      allowedDependencies: entry.allowedDependencies,
      manifest: byRoot.get(entry.root),
    }),
  );
  return {
    declared: context.exists(PROJECT_FILE),
    packages,
    manifests,
    workspaceNames,
  };
}

type JoinedFacts = {
  readonly kind: string | undefined;
  readonly allowedDependencies: readonly string[];
  readonly manifest: PackageManifestFacts | undefined;
};

function joinPackage(context: DoctorContext, name: string, root: string, facts: JoinedFacts): GraphPackage {
  const sources = context.files().filter((path) => isPackageProductionSource(path, root));
  return {
    name,
    root,
    kind: facts.kind,
    allowedDependencies: facts.allowedDependencies,
    manifest: facts.manifest,
    sources,
    imports: sources.flatMap((path) => readSourceImports(path, context.read(path))),
  };
}

// ---------------------------------------------------------------------------
// What a package ships
// ---------------------------------------------------------------------------

/** True for a module under `<root>/src` that is neither a test nor a declaration. */
function isPackageProductionSource(path: string, root: string): boolean {
  if (!path.startsWith(`${root}/src/`)) return false;
  if (!MODULE_EXTENSIONS.some((extension) => path.endsWith(extension))) {
    return false;
  }
  if (path.endsWith(".d.ts")) return false;
  if (TEST_SUFFIXES.some((suffix) => path.endsWith(suffix))) return false;
  return !NOT_PRODUCTION.some((segment) => path.includes(segment));
}

/** Every file of a package, tests included, in the order the file list gave them. */
export function packageFiles(context: DoctorContext, declared: GraphPackage): readonly string[] {
  return context.files().filter((path) => path.startsWith(`${declared.root}/`));
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

function readManifestFacts(context: DoctorContext): readonly PackageManifestFacts[] {
  const found: PackageManifestFacts[] = [];
  for (const path of context.files()) {
    if (path !== MANIFEST_NAME && !path.endsWith(`/${MANIFEST_NAME}`)) continue;
    const parsed = parseManifest(context, path);
    if (parsed !== undefined) found.push(parsed);
  }
  return found;
}

function parseManifest(context: DoctorContext, path: string): PackageManifestFacts | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(context.read(path));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const name: unknown = parsed["name"];
  const peers = readDependencyNames(parsed["peerDependencies"]);
  const peerMeta = isRecord(parsed["peerDependenciesMeta"]) ? parsed["peerDependenciesMeta"] : undefined;
  const requiredPeers = peers.filter((peer) => {
    const entry = peerMeta?.[peer];
    return !(isRecord(entry) && entry["optional"] === true);
  });
  return {
    path,
    name: isString(name) ? name : undefined,
    dependencies: readDependencyNames(parsed["dependencies"]).concat(
      readDependencyNames(parsed["optionalDependencies"]),
    ),
    peerDependencies: peers,
    requiredPeerDependencies: requiredPeers,
    runtimePeers: peers.filter((peer) => RUNTIME_PEERS.includes(peer)),
  };
}

function readDependencyNames(value: unknown): readonly string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

/** The directory a manifest sits in, `""` for the workspace root manifest. */
export function manifestRootOf(manifest: PackageManifestFacts): string {
  const cut = manifest.path.lastIndexOf(`/${MANIFEST_NAME}`);
  return cut === -1 ? "" : manifest.path.slice(0, cut);
}

// ---------------------------------------------------------------------------
// Imports, read from text
// ---------------------------------------------------------------------------

/**
 * Every module specifier a source names, one entry per import.
 *
 * The line is read twice: once with its strings emptied, which is where the
 * shape of an import is counted, and once with its comments removed and its
 * strings intact, which is where the specifier is read. A line whose two
 * readings disagree about how many imports it holds is skipped, because a
 * scanner that cannot be sure has nothing to say.
 */
function readSourceImports(path: string, text: string): readonly PackageImport[] {
  const skeleton = readCodeSkeleton(text);
  const stripped = strippedSourceLines(text);
  const found: PackageImport[] = [];
  for (const [index, line] of skeleton.entries()) {
    const shapes = countMatches(SPECIFIER_IN_SKELETON, line.text);
    if (shapes === 0) continue;
    const specifiers = readSpecifiersOnLine(stripped[index] ?? "");
    for (const specifier of specifiers.slice(0, shapes)) {
      found.push({
        path,
        line: index + 1,
        specifier,
        module: bareModuleOf(specifier),
      });
    }
  }
  return found;
}

/** One entry per line: comments gone, string contents kept. */
export function strippedSourceLines(text: string): readonly string[] {
  let state = CLEAN_STRIP;
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const stripped = stripCommentsFromLine(line, state, false);
    state = stripped.state;
    lines.push(stripped.code);
  }
  return lines;
}

function readSpecifiersOnLine(line: string): readonly string[] {
  const found: string[] = [];
  for (const match of line.matchAll(SPECIFIER_WITH_TEXT)) {
    found.push(match[2] ?? "");
  }
  return found;
}

function countMatches(pattern: RegExp, text: string): number {
  return [...text.matchAll(pattern)].length;
}

/** The package a specifier names, or `undefined` for a relative or builtin one. */
function bareModuleOf(specifier: string): string | undefined {
  if (specifier.length === 0) return undefined;
  if (/^[./#]/.test(specifier)) return undefined;
  if (specifier.startsWith("node:")) return undefined;
  const segments = specifier.split("/");
  const bare = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? "");
  return bare.length === 0 ? undefined : bare;
}

// ---------------------------------------------------------------------------
// The questions signals ask of the graph
// ---------------------------------------------------------------------------

/** True when the module is another package of this workspace. */
function isWorkspaceModule(graph: PackageGraph, module: string): boolean {
  return graph.workspaceNames.has(module);
}

/** Every import of a module outside the workspace, builtins excluded. */
export function vendorImports(graph: PackageGraph, declared: GraphPackage): readonly PackageImport[] {
  return declared.imports.filter(
    (entry) => entry.module !== undefined && entry.module !== declared.name && !isWorkspaceModule(graph, entry.module),
  );
}

/** True when the package says, anywhere it may say it, that it uses the module. */
export function declaresModule(declared: GraphPackage, module: string): boolean {
  if (declared.allowedDependencies.includes(module)) return true;
  const manifest = declared.manifest;
  if (manifest === undefined) return false;
  return manifest.dependencies.includes(module) || manifest.peerDependencies.includes(module);
}

/** Every package that names another package as a dependency it may use. */
export function declaredImportersOf(graph: PackageGraph, name: string): readonly GraphPackage[] {
  return graph.packages.filter((declared) => declared.name !== name && declaresModule(declared, name));
}

/** Every package whose production sources import another workspace package. */
export function importersOf(graph: PackageGraph, name: string): readonly GraphPackage[] {
  return graph.packages.filter(
    (declared) => declared.name !== name && declared.imports.some((entry) => entry.module === name),
  );
}
