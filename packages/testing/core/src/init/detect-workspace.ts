import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, isUnknownArray } from "../parse-guards.js";
import type { InitUnsupported } from "./infer-testing-manifest.js";
import { parsePnpmWorkspaceFile } from "./pnpm-workspace-yaml.js";
import {
  compileWorkspaceGlob,
  expandWorkspaceGlobs,
} from "./workspace-glob.js";

/**
 * What `dad-test init` can learn about a workspace from the files a workspace
 * already has: which package manager runs its scripts, and which directories
 * are its packages. Every conclusion carries the file it came from, so the
 * generated report can say why the manifest looks the way it does.
 */

export type PackageManager = "npm" | "yarn" | "pnpm";

export type PackageManagerSource =
  "pnpm-lock.yaml" | "yarn.lock" | "package-lock.json" | "default";

export type WorkspacePatternSource =
  "pnpm-workspace.yaml" | "package.json#workspaces" | "single-package";

export type DetectedWorkspace = {
  readonly packageManager: PackageManager;
  readonly packageManagerSource: PackageManagerSource;
  readonly patternSource: WorkspacePatternSource;
  readonly patterns: readonly string[];
  readonly packageDirectories: readonly string[];
  readonly ignoredWorkspaceKeys: readonly string[];
  readonly unsupported: readonly InitUnsupported[];
};

type DeclaredPatterns = {
  readonly source: WorkspacePatternSource;
  readonly patterns: readonly string[];
  readonly ignoredKeys: readonly string[];
};

const lockfiles: readonly {
  readonly file: PackageManagerSource;
  readonly manager: PackageManager;
}[] = [
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "package-lock.json", manager: "npm" },
];

export function detectWorkspace(workspaceRoot: string): DetectedWorkspace {
  const unsupported: InitUnsupported[] = [];
  const declared = readDeclaredPatterns(workspaceRoot, unsupported);
  const patterns = declared.patterns.filter((pattern) =>
    patternIsSupported(pattern, unsupported),
  );

  // A workspace that declares no package patterns is one package: the root.
  // Where patterns do exist, the root package is never one of the projects.
  if (patterns.length === 0) {
    return {
      ...detectPackageManager(workspaceRoot),
      patternSource: "single-package",
      patterns: [],
      packageDirectories: ["."],
      ignoredWorkspaceKeys: declared.ignoredKeys,
      unsupported,
    };
  }

  return {
    ...detectPackageManager(workspaceRoot),
    patternSource: declared.source,
    patterns,
    packageDirectories: expandWorkspaceGlobs(workspaceRoot, patterns),
    ignoredWorkspaceKeys: declared.ignoredKeys,
    unsupported,
  };
}

function detectPackageManager(workspaceRoot: string): {
  readonly packageManager: PackageManager;
  readonly packageManagerSource: PackageManagerSource;
} {
  for (const lockfile of lockfiles) {
    if (!existsSync(join(workspaceRoot, lockfile.file))) continue;
    return {
      packageManager: lockfile.manager,
      packageManagerSource: lockfile.file,
    };
  }
  return { packageManager: "npm", packageManagerSource: "default" };
}

/**
 * `pnpm-workspace.yaml` wins where it exists: a pnpm workspace keeps its
 * patterns there, and `package.json#workspaces` is then either absent or stale.
 * An unreadable `pnpm-workspace.yaml` is not treated as an absent one — that
 * would quietly generate a manifest with one project instead of many.
 */
function readDeclaredPatterns(
  workspaceRoot: string,
  unsupported: InitUnsupported[],
): DeclaredPatterns {
  const pnpmFile = join(workspaceRoot, "pnpm-workspace.yaml");
  if (existsSync(pnpmFile)) {
    const parsed = parsePnpmWorkspaceFile(
      readFileSync(pnpmFile, "utf8"),
      "pnpm-workspace.yaml",
    );
    return {
      source: "pnpm-workspace.yaml",
      patterns: parsed.packages,
      ignoredKeys: parsed.ignoredKeys,
    };
  }
  return {
    source: "package.json#workspaces",
    patterns: readPackageJsonWorkspaces(workspaceRoot, unsupported),
    ignoredKeys: [],
  };
}

function readPackageJsonWorkspaces(
  workspaceRoot: string,
  unsupported: InitUnsupported[],
): readonly string[] {
  const document = readRootPackageJson(workspaceRoot);
  if (document === undefined) return [];
  const workspaces = document["workspaces"];
  if (workspaces === undefined) return [];
  if (isUnknownArray(workspaces)) {
    return readPatternArray(workspaces, "package.json#workspaces", unsupported);
  }
  if (isRecord(workspaces)) {
    const packages = workspaces["packages"];
    if (isUnknownArray(packages)) {
      return readPatternArray(
        packages,
        "package.json#workspaces.packages",
        unsupported,
      );
    }
  }
  unsupported.push({
    subject: "package.json#workspaces",
    message:
      "workspaces must be an array of patterns or an object with a packages array.",
  });
  return [];
}

function readPatternArray(
  values: readonly unknown[],
  subject: string,
  unsupported: InitUnsupported[],
): readonly string[] {
  const patterns: string[] = [];
  for (const value of values) {
    if (typeof value === "string") {
      patterns.push(value);
      continue;
    }
    unsupported.push({
      subject,
      message: "every workspace pattern must be a string.",
    });
  }
  return patterns;
}

/**
 * A pattern this reader cannot compile is dropped and named, rather than
 * failing the whole command: the rest of the workspace still generates, and the
 * report says which packages were not looked for.
 */
function patternIsSupported(
  pattern: string,
  unsupported: InitUnsupported[],
): boolean {
  try {
    compileWorkspaceGlob(pattern);
    return true;
  } catch (error: unknown) {
    unsupported.push({
      subject: pattern,
      message: error instanceof Error ? error.message : "unsupported pattern.",
    });
    return false;
  }
}

/** An unreadable root `package.json` is reported by the package inventory. */
function readRootPackageJson(
  workspaceRoot: string,
): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(workspaceRoot, "package.json"), "utf8"),
    );
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
