import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { isRecord, isUnknownArray } from "../parse-guards.js";
import type { TestingManifestProject } from "../testing-manifest.js";
import { compareText } from "./infer-one-package.js";
import type { InitInference } from "./infer-testing-manifest.js";
import type { ProjectIdAssignment } from "./project-ids.js";

/**
 * File-system discovery for single-package Dads applications: reads package
 * declarations from `dads.project.json`, computes acyclic domain fallback
 * dependencies, and locates unit/integration test files per root.
 */

export type DeclaredDadsPackage = {
  readonly name: string;
  readonly root: string;
  readonly kind: string;
};

export type DiscoveredTests = {
  readonly hasUnit: boolean;
  readonly hasIntegration: boolean;
};

type ProjectBuckets = {
  readonly libraryIds: readonly string[];
  readonly migrationIds: readonly string[];
  readonly domainIds: readonly string[];
};

export const unitSuffixes: readonly string[] = [
  ".test.ts",
  ".test.tsx",
  ".test.mts",
  ".test.js",
  ".test.mjs",
  ".spec.ts",
  ".spec.tsx",
  ".spec.mts",
];

export const integrationSuffixes: readonly string[] = [
  ".integration.test.ts",
  ".integration.test.tsx",
  ".integration.test.mts",
  ".integration.test.js",
  ".integration.test.mjs",
  ".integration.spec.ts",
  ".integration.spec.tsx",
];

export const setupCandidates: readonly string[] = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.setup.ts",
  "vitest.setup.mts",
  "vitest.setup.js",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
];

const ignoredDirectories = new Set(["node_modules", ".git", "dist", "build", "coverage", ".lake", "_apalache-out"]);

export function readDadsProjectPackages(workspaceRoot: string): readonly DeclaredDadsPackage[] | undefined {
  const rawPackages = readRawDadsPackagesArray(workspaceRoot);
  if (rawPackages === undefined) return undefined;
  const seenRoots = new Set<string>();
  const packages: DeclaredDadsPackage[] = [];
  for (const entry of rawPackages) {
    const parsed = parseDeclaredPackage(workspaceRoot, entry, seenRoots);
    if (parsed !== undefined) packages.push(parsed);
  }
  return packages;
}

export function buildSubProjects(
  declared: readonly DeclaredDadsPackage[],
  idByRoot: ReadonlyMap<string, ProjectIdAssignment>,
  inferences: InitInference[],
): readonly TestingManifestProject[] {
  const buckets = classifyProjectBuckets(declared, idByRoot);
  return declared.flatMap((entry): TestingManifestProject[] => {
    const id = idByRoot.get(entry.root)?.projectId;
    if (id === undefined) return [];
    const fallbackDependencies = fallbackDependenciesForEntry(entry, id, buckets);
    inferences.push({ kind: "project-id", subject: id, detail: `from dads.project.json (${entry.root})` });
    return [{ id, root: entry.root, fallbackDependencies }];
  });
}

export function discoverTestsInRoot(
  workspaceRoot: string,
  root: string,
  excludedSubRoots: ReadonlySet<string>,
): DiscoveredTests {
  const state = { hasUnit: false, hasIntegration: false };
  const startDir = root === "." ? workspaceRoot : join(workspaceRoot, root);
  walkDirectoryForTests(startDir, root === "." ? "" : root, excludedSubRoots, state);
  return state;
}

function readRawDadsPackagesArray(workspaceRoot: string): readonly unknown[] | undefined {
  const configPath = join(workspaceRoot, "dads.project.json");
  if (!existsSync(configPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    return isRecord(parsed) && isUnknownArray(parsed["packages"]) ? parsed["packages"] : undefined;
  } catch {
    return undefined;
  }
}

function parseDeclaredPackage(
  workspaceRoot: string,
  entry: unknown,
  seenRoots: Set<string>,
): DeclaredDadsPackage | undefined {
  if (!isRecord(entry)) return undefined;
  const name = entry["name"];
  const rawRoot = entry["root"];
  if (typeof name !== "string" || typeof rawRoot !== "string") return undefined;
  const root = normalizeRoot(rawRoot);
  if (root === "." || seenRoots.has(root) || !existsSync(join(workspaceRoot, root))) return undefined;
  seenRoots.add(root);
  const kind = typeof entry["kind"] === "string" ? entry["kind"] : "core";
  return { name, root, kind };
}

function normalizeRoot(raw: string): string {
  const cleaned = raw.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return cleaned.length === 0 ? "." : cleaned;
}

function classifyProjectBuckets(
  declared: readonly DeclaredDadsPackage[],
  idByRoot: ReadonlyMap<string, ProjectIdAssignment>,
): ProjectBuckets {
  const libraryIds: string[] = [];
  const migrationIds: string[] = [];
  const domainIds: string[] = [];
  for (const entry of declared) {
    const id = idByRoot.get(entry.root)?.projectId;
    if (id === undefined) continue;
    if (isMigrationRoot(entry.root)) migrationIds.push(id);
    else if (entry.root.startsWith("libraries/")) libraryIds.push(id);
    else if (isDomainRoot(entry.root)) domainIds.push(id);
  }
  return { libraryIds, migrationIds, domainIds };
}

function fallbackDependenciesForEntry(
  entry: DeclaredDadsPackage,
  id: string,
  buckets: ProjectBuckets,
): readonly string[] {
  const fallbacks = new Set<string>();
  if (isDomainRoot(entry.root)) {
    for (const dep of buckets.libraryIds) fallbacks.add(dep);
  } else if (isCompositionEntry(entry)) {
    for (const dep of [...buckets.libraryIds, ...buckets.domainIds, ...buckets.migrationIds]) {
      fallbacks.add(dep);
    }
  }
  fallbacks.delete(id);
  return [...fallbacks].sort(compareText);
}

function isMigrationRoot(root: string): boolean {
  return root === "migrations" || root.startsWith("migrations/");
}

function isDomainRoot(root: string): boolean {
  return root.startsWith("domains/") || root.startsWith("src/domains/");
}

function isCompositionEntry(entry: DeclaredDadsPackage): boolean {
  return entry.kind === "application" || (entry.kind === "binding" && !isMigrationRoot(entry.root));
}

function walkDirectoryForTests(
  dir: string,
  relativePrefix: string,
  excludedSubRoots: ReadonlySet<string>,
  state: { hasUnit: boolean; hasIntegration: boolean },
): void {
  if (state.hasUnit && state.hasIntegration) return;
  for (const entry of safeReadDir(dir)) {
    if (ignoredDirectories.has(entry.name)) continue;
    const relativePath = relativePrefix.length === 0 ? entry.name : `${relativePrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!excludedSubRoots.has(relativePath)) {
        walkDirectoryForTests(join(dir, entry.name), relativePath, excludedSubRoots, state);
      }
      continue;
    }
    if (entry.isFile()) recordTestFile(entry.name, state);
  }
}

function safeReadDir(dir: string): readonly Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function recordTestFile(name: string, state: { hasUnit: boolean; hasIntegration: boolean }): void {
  if (integrationSuffixes.some((suffix) => name.endsWith(suffix))) {
    state.hasIntegration = true;
  } else if (unitSuffixes.some((suffix) => name.endsWith(suffix))) {
    state.hasUnit = true;
  }
}
