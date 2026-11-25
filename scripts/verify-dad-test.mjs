/**
 * Dogfoods the repository's own native `dad-test` engine inside local
 * `npm run verify` runs (`verify-test-step.mjs`, `check-test-types.mjs`).
 *
 * When a local `dad-test` binary is built and the local verify cache is active
 * (never under `CI`, `--no-cache`, or `--full`), this helper queries `dad-test`
 * for:
 *
 * 1. Per-package Oxc-proven `cacheInputs` closures (`projectRoots`,
 *    `impactPaths`, `extraFiles`), turned into content-addressed SHA-256 keys
 *    over the run's `verify-fingerprint.mjs` snapshot.
 * 2. Exact `dad-test plan --base <cleanCommit>` skip proofs for any package
 *    whose closure key missed but which already passed on a clean commit.
 *
 * Every failure path fails closed and returns empty/null so callers fall back
 * cleanly to `verify-workspace.mjs` or full execution.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { relevantEnvironment } from "./verify-cache.mjs";
import { git } from "./verify-fingerprint.mjs";
import { rootFiles } from "./verify-workspace.mjs";

const PROTOCOL_SCHEMA_VERSION = 1;
const CLOSURE_KEY_VERSION = 1;
const MANIFEST_NAME = "dads.testing.json";

/** Finds a locally built `dad-test` executable, or null when none exists. */
export function resolveLocalDadTestBinary(root, env = process.env, platform = process.platform) {
  const configured = env.DADS_TEST_NATIVE_BINARY?.trim();
  if (configured !== undefined && configured.length > 0) {
    const resolved = resolve(root, configured);
    return existsSync(resolved) ? resolved : null;
  }
  const executable = platform === "win32" ? "dad-test.exe" : "dad-test";
  for (const profile of ["release", "debug"]) {
    const candidate = join(root, "target", profile, executable);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Runs one native `dad-test` JSON request over stdin/stdout; null on any error. */
export function invokeDadTest(binary, request) {
  const completed = spawnSync(binary, [], {
    input: JSON.stringify(request),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (completed.error !== undefined || completed.status !== 0) return null;
  try {
    const parsed = JSON.parse(completed.stdout.trim());
    if (parsed?.schemaVersion !== PROTOCOL_SCHEMA_VERSION || parsed.ok !== true) return null;
    return parsed.result ?? null;
  } catch {
    return null;
  }
}

/** Reads `projectId -> projectRoot` from root `dads.testing.json`, or null. */
export function loadManifestProjectRoots(root) {
  const manifestPath = join(root, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!Array.isArray(manifest?.projects)) return null;
    const byId = new Map();
    for (const project of manifest.projects) {
      if (typeof project?.id === "string" && typeof project?.root === "string") {
        byId.set(project.id, project.root);
      }
    }
    return byId;
  } catch {
    return null;
  }
}

/**
 * Queries `dad-test` once for Oxc-computed `cacheInputs` closures of all tasks
 * matching `taskKind`. Returns `Map<directory, cacheInputs>` or null.
 */
export function loadDadTestCacheClosures(root, env, taskKind) {
  const binary = resolveLocalDadTestBinary(root, env);
  if (binary === null) return null;
  const projectRoots = loadManifestProjectRoots(root);
  if (projectRoots === null) return null;
  const result = invokeDadTest(binary, {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    operation: "plan",
    workspaceRoot: resolve(root),
    only: true,
    all: false,
    taskIds: [],
    taskKinds: [taskKind],
    cache: true,
  });
  const tasks = result?.plan?.tasks;
  if (!Array.isArray(tasks)) return null;
  return collectClosuresByDirectory(tasks, projectRoots);
}

function collectClosuresByDirectory(tasks, projectRoots) {
  const byDirectory = new Map();
  const invalid = new Set();
  for (const task of tasks) {
    const directory = projectRoots.get(task.project);
    if (directory === undefined) continue;
    const inputs = task.cacheInputs;
    if (inputs?.cacheable !== true) {
      invalid.add(directory);
      byDirectory.delete(directory);
      continue;
    }
    if (invalid.has(directory)) continue;
    const existing = byDirectory.get(directory);
    byDirectory.set(directory, mergeCacheInputs(existing, inputs));
  }
  return byDirectory;
}

function mergeCacheInputs(existing, next) {
  const mergeList = (left = [], right = []) => [...new Set([...left, ...right])].sort();
  return {
    projectRoots: mergeList(existing?.projectRoots, next.projectRoots),
    impactPaths: mergeList(existing?.impactPaths, next.impactPaths),
    extraFiles: mergeList(existing?.extraFiles, next.extraFiles),
  };
}

/** Matches a workspace-relative path against a prefix or `*`/`**` glob. */
export function pathMatchesPattern(path, pattern) {
  const normalized = pattern === "." ? "." : pattern.replace(/\/+$/u, "");
  if (normalized.length === 0) return false;
  if (normalized === ".") return true;
  if (!normalized.includes("*")) {
    return path === normalized || path.startsWith(`${normalized}/`);
  }
  return matchSegments(path.split("/"), normalized.split("/"));
}

function matchSegments(pathParts, patternParts) {
  if (pathParts.length === 0 && patternParts.length === 0) return true;
  if (patternParts[0] === "**") {
    return (
      matchSegments(pathParts, patternParts.slice(1)) ||
      (pathParts.length > 0 && matchSegments(pathParts.slice(1), patternParts))
    );
  }
  if (pathParts.length === 0 || patternParts.length === 0) return false;
  return (
    matchSegmentWildcard(pathParts[0], patternParts[0]) && matchSegments(pathParts.slice(1), patternParts.slice(1))
  );
}

function matchSegmentWildcard(segment, pattern) {
  if (!pattern.includes("*")) return segment === pattern;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", "[^/]*");
  return new RegExp(`^${escaped}$`, "u").test(segment);
}

function hashPatternMatches(entries, patterns) {
  if (patterns.length === 0) return [];
  const exact = [];
  const globs = [];
  for (const pattern of patterns) {
    if (pattern.includes("*")) globs.push(pattern);
    else exact.push(pattern.replace(/\/+$/u, ""));
  }
  const matched = new Map();
  for (const path of exact) {
    matched.set(path, entries[path] ?? "absent");
  }
  if (globs.length > 0) {
    for (const [path, oid] of Object.entries(entries)) {
      if (globs.some((glob) => pathMatchesPattern(path, glob))) {
        matched.set(path, oid);
      }
    }
  }
  return [...matched.entries()].sort(([left], [right]) => (left < right ? -1 : 1));
}

/**
 * Content-addressed SHA-256 cache key built from a `dad-test` Oxc closure and
 * the current `verify-fingerprint.mjs` snapshot.
 */
export function dadTestClosureKey(context, closure, command) {
  const { fingerprint } = context;
  if (fingerprint.error !== undefined || fingerprint.ignored === null) return null;
  const entries = fingerprint.entries;
  const allPatterns = [...closure.projectRoots, ...closure.impactPaths, ...closure.extraFiles];
  const material = JSON.stringify({
    source: "dad-test-closure",
    version: CLOSURE_KEY_VERSION,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    environment: relevantEnvironment(context.environment),
    command,
    directories: closure.projectRoots.map((directory) => [directory, entries[directory] ?? "absent"]),
    impactEntries: hashPatternMatches(entries, [...closure.impactPaths, ...closure.extraFiles]),
    rootFiles: rootFiles(entries),
    ignored: fingerprint.ignored.filter(
      ([path]) => !path.includes("/") || allPatterns.some((pattern) => pathMatchesPattern(path, pattern)),
    ),
  });
  return createHash("sha256").update(material).digest("hex");
}

/** SHA-256 of the execution runtime and command, independent of repo files. */
export function runtimeEnvironmentKey(context, command) {
  const material = JSON.stringify({
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    environment: relevantEnvironment(context.environment),
    command,
  });
  return createHash("sha256").update(material).digest("hex");
}

/** SHA-256 of all non-derived gitignored inputs in the current fingerprint. */
export function ignoredInputsHash(fingerprint) {
  if (fingerprint.error !== undefined || fingerprint.ignored === null) return null;
  return createHash("sha256").update(JSON.stringify(fingerprint.ignored)).digest("hex");
}

/** Returns `HEAD`'s commit SHA only when the working tree exactly matches it. */
export function cleanHeadCommit(root, fingerprint) {
  const commit = fingerprint.history?.commit;
  if (typeof commit !== "string" || commit.length === 0) return null;
  try {
    const headTree = git(root, ["rev-parse", "--verify", `${commit}^{tree}`]).trim();
    return headTree === fingerprint.tree ? commit : null;
  } catch {
    return null;
  }
}

/**
 * Uses `dad-test plan --base <cleanCommit>` to prove remaining packages
 * unaffected when their prior passing record came from a clean commit with the
 * same runtime and ignored inputs.
 */
export function narrowPackagesWithDadTestPlan({ root, env, cache, toRun, taskKind, command, readRecord, recordKind }) {
  if (toRun.length === 0) return { provenUnaffected: [], remaining: toRun };
  const binary = resolveLocalDadTestBinary(root, env);
  const projectRoots = binary === null ? null : loadManifestProjectRoots(root);
  const currentIgnored = ignoredInputsHash(cache.fingerprint);
  if (binary === null || projectRoots === null || currentIgnored === null) {
    return { provenUnaffected: [], remaining: toRun };
  }
  const currentRuntime = runtimeEnvironmentKey(cache, command);
  const byCommit = groupEligibleByCommit(toRun, { cache, recordKind, readRecord, currentRuntime, currentIgnored });
  const unaffectedDirs = collectProvenUnaffectedDirectories({ binary, root, taskKind, projectRoots, byCommit });
  return {
    provenUnaffected: toRun.filter((item) => unaffectedDirs.has(item.directory)),
    remaining: toRun.filter((item) => !unaffectedDirs.has(item.directory)),
  };
}

function groupEligibleByCommit(toRun, { cache, recordKind, readRecord, currentRuntime, currentIgnored }) {
  const byCommit = new Map();
  for (const item of toRun) {
    const record = readRecord(cache, recordKind, item.directory);
    if (!isCleanPlanEligible(record, currentRuntime, currentIgnored)) continue;
    const list = byCommit.get(record.cleanCommit) ?? [];
    list.push(item.directory);
    byCommit.set(record.cleanCommit, list);
  }
  return byCommit;
}

function isCleanPlanEligible(record, currentRuntime, currentIgnored) {
  return (
    record !== null &&
    typeof record.cleanCommit === "string" &&
    record.cleanCommit.length > 0 &&
    record.runtimeKey === currentRuntime &&
    record.ignoredHash === currentIgnored &&
    Array.isArray(record.suites) &&
    record.suites.length > 0
  );
}

function collectProvenUnaffectedDirectories({ binary, root, taskKind, projectRoots, byCommit }) {
  const unaffected = new Set();
  for (const [baseCommit, directories] of byCommit) {
    const result = invokeDadTest(binary, {
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      operation: "plan",
      workspaceRoot: resolve(root),
      base: baseCommit,
      all: false,
      taskIds: [],
      taskKinds: [taskKind],
    });
    const plan = result?.plan;
    if (plan?.complete !== true || plan.scope?.fullFallback !== false || !Array.isArray(plan.tasks)) {
      continue;
    }
    const decisionsByDir = mapDecisionsByDirectory(plan.tasks, projectRoots);
    for (const directory of directories) {
      const decisions = decisionsByDir.get(directory);
      if (decisions !== undefined && decisions.length > 0 && decisions.every((d) => d === "skip-proven-unaffected")) {
        unaffected.add(directory);
      }
    }
  }
  return unaffected;
}

function mapDecisionsByDirectory(tasks, projectRoots) {
  const map = new Map();
  for (const task of tasks) {
    const directory = projectRoots.get(task.project);
    if (directory === undefined) continue;
    const list = map.get(directory) ?? [];
    list.push(task.decision);
    map.set(directory, list);
  }
  return map;
}
