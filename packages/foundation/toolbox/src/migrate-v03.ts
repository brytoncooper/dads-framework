import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

import {
  PEERS_FOR_RETIRED_PACKAGE,
  RETIRED_PACKAGE_TO_TARGET,
  rewriteV03ImportSpecifier,
  V03_TARGET_VERSION,
} from "./migrate-v03-map.js";
import { isRecord } from "./parse-guards.js";

const IGNORED_DIRECTORIES = new Set([".git", ".next", ".turbo", "coverage", "dist", "node_modules", "target"]);
const SOURCE_EXTENSIONS = new Set([".cjs", ".css", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const QUOTED_DADS_SPECIFIER = /(["'])(@dads-framework\/[^"'\s]+)\1/gu;
const POSTGRES_ACCESS_PACKAGE = "@dads-framework/postgres-access";
const MIGRATION_FILE_PATTERN = /(?:^|\/)[^/]+\.migration\.[cm]?[jt]s$/u;
const MIGRATIONS_DIR_PATTERN = /(?:^|\/)migrations\/[^/]+\.[cm]?[jt]s$/u;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]s$/u;
const EXPIRATION_MIGRATION_PATTERN = /\brelationshipExpirationMigration\b|\bexpires_at\b/u;

export type MigrateTargetVersion =
  "0.3.0" | "0.4.0" | "0.5.0" | "0.5.1" | "0.5.2" | "0.6.0" | "0.6.1" | "0.6.2" | "0.6.3";

export type MigrateToV03Options = {
  readonly root: string;
  readonly dryRun?: boolean;
  readonly includeMigrations?: boolean;
  readonly targetVersion?: MigrateTargetVersion;
};

export type MigrateToV03Result = {
  readonly root: string;
  readonly targetVersion: MigrateTargetVersion;
  readonly dryRun: boolean;
  readonly filesChanged: readonly string[];
  readonly packageManifestsUpdated: number;
  readonly importReplacements: number;
  readonly addedPeers: readonly string[];
  readonly skippedMigrations: readonly string[];
  readonly followUps: readonly string[];
};

type MigrationRunState = {
  readonly targetVersion: MigrateTargetVersion;
  readonly filesChanged: string[];
  readonly addedPeers: Set<string>;
  readonly skippedMigrations: string[];
  packageManifestsUpdated: number;
  importReplacements: number;
  usesPostgresAccess: boolean;
  hasRelationshipExpirationMigration: boolean;
};

/**
 * Rewrites a 0.1.x / 0.2.x / 0.3.x Dads workspace to the consolidated target version.
 * Idempotent: running a second time produces zero edits.
 */
export function migrateWorkspaceToV03(options: MigrateToV03Options): MigrateToV03Result {
  const root = resolve(options.root);
  const dryRun = options.dryRun === true;
  const includeMigrations = options.includeMigrations === true;
  const targetVersion = options.targetVersion ?? V03_TARGET_VERSION;
  const state: MigrationRunState = {
    targetVersion,
    filesChanged: [],
    addedPeers: new Set<string>(),
    skippedMigrations: [],
    packageManifestsUpdated: 0,
    importReplacements: 0,
    usesPostgresAccess: false,
    hasRelationshipExpirationMigration: false,
  };

  for (const absolutePath of collectCandidateFiles(root)) {
    processCandidateFile(root, absolutePath, dryRun, includeMigrations, state);
  }

  return {
    root,
    targetVersion,
    dryRun,
    filesChanged: state.filesChanged.sort(),
    packageManifestsUpdated: state.packageManifestsUpdated,
    importReplacements: state.importReplacements,
    addedPeers: [...state.addedPeers].sort(),
    skippedMigrations: state.skippedMigrations.sort(),
    followUps: buildFollowUps(state),
  };
}

function processCandidateFile(
  root: string,
  absolutePath: string,
  dryRun: boolean,
  includeMigrations: boolean,
  state: MigrationRunState,
): void {
  const relativePath = toPosixPath(relative(root, absolutePath));
  const original = readFileSync(absolutePath, "utf8");
  if (handleMigrationFile(relativePath, original, includeMigrations, state)) return;

  const updated = transformFile(relativePath, original, state.addedPeers, state.targetVersion, (count) => {
    state.importReplacements += count;
  });
  const isManifest = isPackageManifestPath(relativePath);
  if (isManifest) recordPostgresAccessUsage(original, updated, state);
  if (updated === original) return;

  state.filesChanged.push(relativePath);
  if (isManifest) state.packageManifestsUpdated += 1;
  if (!dryRun) writeFileSync(absolutePath, updated, "utf8");
}

function handleMigrationFile(
  relativePath: string,
  original: string,
  includeMigrations: boolean,
  state: MigrationRunState,
): boolean {
  if (!isMigrationPath(relativePath)) return false;
  if (EXPIRATION_MIGRATION_PATTERN.test(original)) {
    state.hasRelationshipExpirationMigration = true;
  }
  if (includeMigrations) return false;
  if (containsRetiredSpecifier(original)) state.skippedMigrations.push(relativePath);
  return true;
}

function recordPostgresAccessUsage(original: string, updated: string, state: MigrationRunState): void {
  if (manifestDependsOn(original, POSTGRES_ACCESS_PACKAGE) || manifestDependsOn(updated, POSTGRES_ACCESS_PACKAGE)) {
    state.usesPostgresAccess = true;
  }
}

function buildFollowUps(state: MigrationRunState): readonly string[] {
  const followUps: string[] = [];
  if (state.skippedMigrations.length > 0) {
    followUps.push(
      `Skipped ${String(state.skippedMigrations.length)} immutable migration file(s) containing retired @dads-framework/* imports so already-applied migrations remain intact. Keep applied migrations unchanged (using moduleAliases/tsconfig paths if needed), or re-run with --include-migrations if they have not been applied yet.`,
    );
  }
  if (state.usesPostgresAccess && !state.hasRelationshipExpirationMigration) {
    followUps.push(
      "Add a new additive database migration executing relationshipExpirationMigration.sql from @dads-framework/postgres-access (adds expires_at timestamptz NULL and its partial index to dad_authorization_relationship) before running Postgres authorization checks.",
    );
  }
  return followUps;
}

function isMigrationPath(relativePath: string): boolean {
  if (TEST_FILE_PATTERN.test(relativePath)) return false;
  return MIGRATION_FILE_PATTERN.test(relativePath) || MIGRATIONS_DIR_PATTERN.test(relativePath);
}

function containsRetiredSpecifier(content: string): boolean {
  for (const match of content.matchAll(QUOTED_DADS_SPECIFIER)) {
    const specifier = match[2];
    if (specifier !== undefined && rewriteV03ImportSpecifier(specifier) !== specifier) {
      return true;
    }
  }
  return false;
}

function manifestDependsOn(content: string, packageName: string): boolean {
  const parsed = parseJsonRecord(content);
  if (parsed === undefined) return false;
  return DEPENDENCY_SECTIONS.some((sectionName) => {
    const section = parsed[sectionName];
    return isRecord(section) && Object.hasOwn(section, packageName);
  });
}

function isPackageManifestPath(relativePath: string): boolean {
  return relativePath === "package.json" || relativePath.endsWith("/package.json");
}

function transformFile(
  relativePath: string,
  original: string,
  addedPeers: Set<string>,
  targetVersion: MigrateTargetVersion,
  onImportReplacements: (count: number) => void,
): string {
  const baseName = relativePath.split("/").pop() ?? relativePath;
  if (baseName === "package.json") {
    return rewritePackageJson(original, addedPeers, targetVersion);
  }
  if (baseName === "dads.project.json") {
    return rewriteDadsProjectJson(original);
  }
  if (!isSpecifierBearingFile(baseName)) return original;

  let count = 0;
  const rewritten = original.replace(
    QUOTED_DADS_SPECIFIER,
    (full: string, quote: string, specifier: string, offset: number, source: string) => {
      // Preserve object-literal keys such as `moduleAliases` or `tsconfig` path aliases.
      if (/^\s*:/u.test(source.slice(offset + full.length))) return full;
      const next = rewriteV03ImportSpecifier(specifier);
      if (next === specifier) return full;
      count += 1;
      return `${quote}${next}${quote}`;
    },
  );
  onImportReplacements(count);
  return rewritten;
}

function isSpecifierBearingFile(baseName: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(baseName)) || /^tsconfig(?:\..+)?\.json$/u.test(baseName);
}

function rewritePackageJson(original: string, addedPeers: Set<string>, targetVersion: MigrateTargetVersion): string {
  const parsed = parseJsonRecord(original);
  if (parsed === undefined) return original;

  const nextManifest: Record<string, unknown> = { ...parsed };
  const peersToAdd: Record<string, string> = {};
  let changed = false;

  for (const sectionName of DEPENDENCY_SECTIONS) {
    const rawSection = parsed[sectionName];
    if (!isRecord(rawSection)) continue;
    const result = rewriteDependencySection(
      rawSection,
      sectionName === "dependencies" ? peersToAdd : undefined,
      targetVersion,
    );
    if (!result.changed) continue;
    changed = true;
    nextManifest[sectionName] = sortRecord(result.entries);
  }

  if (mergeAddedPeers(nextManifest, peersToAdd, addedPeers)) {
    changed = true;
  }

  return changed ? `${JSON.stringify(nextManifest, null, 2)}\n` : original;
}

function rewriteDependencySection(
  rawSection: Readonly<Record<string, unknown>>,
  peersToAdd: Record<string, string> | undefined,
  targetVersion: MigrateTargetVersion,
): { readonly changed: boolean; readonly entries: Record<string, string> } {
  const entries: Record<string, string> = {};
  let changed = false;

  for (const [name, version] of Object.entries(rawSection)) {
    if (typeof version !== "string") continue;
    const target = lookupRetiredTarget(name);
    if (target !== undefined) {
      changed = true;
      entries[target] = resolveUpgradedVersion(version, targetVersion);
      collectPeersForRetired(name, peersToAdd);
      continue;
    }
    const nextVersion = isDadsPackage(name) ? resolveUpgradedVersion(version, targetVersion) : version;
    if (nextVersion !== version) changed = true;
    entries[name] = nextVersion;
  }

  return { changed, entries };
}

function collectPeersForRetired(retiredName: string, peersToAdd: Record<string, string> | undefined): void {
  if (peersToAdd === undefined) return;
  const requiredPeers = Object.hasOwn(PEERS_FOR_RETIRED_PACKAGE, retiredName)
    ? PEERS_FOR_RETIRED_PACKAGE[retiredName]
    : undefined;
  if (requiredPeers === undefined) return;
  for (const [peerName, peerVersion] of Object.entries(requiredPeers)) {
    peersToAdd[peerName] = peerVersion;
  }
}

function mergeAddedPeers(
  manifest: Record<string, unknown>,
  peersToAdd: Readonly<Record<string, string>>,
  addedPeers: Set<string>,
): boolean {
  const names = Object.keys(peersToAdd);
  if (names.length === 0) return false;

  const deps = readStringMap(manifest["dependencies"]);
  const devDeps = readStringMap(manifest["devDependencies"]);
  const peers = readStringMap(manifest["peerDependencies"]);
  let changed = false;

  for (const [peerName, peerVersion] of Object.entries(peersToAdd)) {
    if (Object.hasOwn(deps, peerName) || Object.hasOwn(devDeps, peerName) || Object.hasOwn(peers, peerName)) {
      continue;
    }
    deps[peerName] = peerVersion;
    addedPeers.add(peerName);
    changed = true;
  }

  if (changed) manifest["dependencies"] = sortRecord(deps);
  return changed;
}

function rewriteDadsProjectJson(original: string): string {
  const parsed = parseJsonRecord(original);
  if (parsed === undefined || !Array.isArray(parsed["packages"])) {
    return original;
  }

  const results = parsed["packages"].map((entry: unknown) => rewriteProjectPackageEntry(entry));
  if (!results.some((result) => result.changed)) return original;

  const nextPackages = results.map((result) => result.entry);
  return `${JSON.stringify({ ...parsed, packages: nextPackages }, null, 2)}\n`;
}

function rewriteProjectPackageEntry(entry: unknown): {
  readonly changed: boolean;
  readonly entry: unknown;
} {
  if (!isRecord(entry) || !Array.isArray(entry["allowedDependencies"])) {
    return { changed: false, entry };
  }
  const seen = new Set<string>();
  const rewritten: string[] = [];
  let changed = false;

  for (const item of entry["allowedDependencies"]) {
    if (typeof item !== "string") continue;
    const mapped = lookupRetiredTarget(item);
    const target = mapped ?? item;
    if (mapped !== undefined || seen.has(target)) changed = true;
    if (seen.has(target)) continue;
    seen.add(target);
    rewritten.push(target);
  }

  if (!changed) return { changed: false, entry };
  return {
    changed: true,
    entry: { ...entry, allowedDependencies: rewritten.sort() },
  };
}

function lookupRetiredTarget(packageName: string): string | undefined {
  return Object.hasOwn(RETIRED_PACKAGE_TO_TARGET, packageName) ? RETIRED_PACKAGE_TO_TARGET[packageName] : undefined;
}

function isDadsPackage(packageName: string): boolean {
  return packageName.startsWith("@dads-framework/") || packageName === "create-dads";
}

function resolveUpgradedVersion(current: string, targetVersion: MigrateTargetVersion): string {
  if (/^(?:workspace|file|link):/u.test(current)) return current;
  if (current.startsWith("^")) return `^${targetVersion}`;
  if (current.startsWith("~")) return `~${targetVersion}`;
  return targetVersion;
}

function parseJsonRecord(text: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function sortRecord(record: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function collectCandidateFiles(root: string): readonly string[] {
  const results: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) walk(join(directory, entry.name));
        continue;
      }
      if (entry.isFile() && isMigrationCandidate(entry.name)) results.push(join(directory, entry.name));
    }
  };
  walk(root);
  return results;
}

function isMigrationCandidate(name: string): boolean {
  return name === "package.json" || name === "dads.project.json" || isSpecifierBearingFile(name);
}

function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}
