import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../parse-guards.js";
import { detectWorkspace, type DetectedWorkspace, type PackageManager } from "./detect-workspace.js";
import { compareText } from "./infer-one-package.js";
import { stripJsonComments } from "./strip-json-comments.js";

/**
 * Scans a workspace to determine whether projects are declared via Nx
 * `project.json` files or via npm/pnpm/yarn `package.json` workspace globs,
 * returning compact `workspace.discover` patterns and per-project target sets.
 */

export type ScannedProject = {
  readonly root: string;
  readonly targets: ReadonlySet<string>;
};

export type WorkspaceLayout = {
  readonly kind: "nx-project-json" | "package-json";
  readonly packageManager: PackageManager;
  readonly projectFiles: readonly string[];
  readonly excludeRoots: readonly string[];
  readonly projects: readonly ScannedProject[];
};

const ignoredWalkDirs = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  ".next",
  ".nx",
  ".lake",
  "_apalache-out",
]);

export function scanWorkspaceLayout(workspaceRoot: string): WorkspaceLayout {
  const detected = detectWorkspace(workspaceRoot);
  const nxProjectFiles = collectNamedFiles(workspaceRoot, "", "project.json");
  if (nxProjectFiles.length > 0) {
    return buildNxLayout(workspaceRoot, detected.packageManager, nxProjectFiles);
  }
  return buildPackageJsonLayout(workspaceRoot, detected);
}

function buildNxLayout(
  workspaceRoot: string,
  packageManager: PackageManager,
  relFiles: readonly string[],
): WorkspaceLayout {
  return {
    kind: "nx-project-json",
    packageManager,
    projectFiles: deriveProjectJsonGlobs(relFiles),
    excludeRoots: [],
    projects: relFiles.map((relFile) => readScannedProject(workspaceRoot, relFile)),
  };
}

function buildPackageJsonLayout(workspaceRoot: string, detected: DetectedWorkspace): WorkspaceLayout {
  const { projectFiles, excludeRoots } = translateWorkspacePatterns(detected.patterns);
  const projects = detected.packageDirectories.map((directory) => {
    const relFile = directory === "." ? "package.json" : `${directory}/package.json`;
    return readScannedProject(workspaceRoot, relFile);
  });
  return {
    kind: "package-json",
    packageManager: detected.packageManager,
    projectFiles,
    excludeRoots,
    projects,
  };
}

function translateWorkspacePatterns(patterns: readonly string[]): {
  readonly projectFiles: readonly string[];
  readonly excludeRoots: readonly string[];
} {
  if (patterns.length === 0) {
    return { projectFiles: ["package.json"], excludeRoots: [] };
  }
  const projectFiles = new Set<string>();
  const excludeRoots = new Set<string>();
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const cleaned = stripRelativeSlashes(negated ? raw.slice(1) : raw);
    if (cleaned.length === 0) continue;
    if (negated) {
      excludeRoots.add(cleaned);
    } else {
      projectFiles.add(cleaned === "." ? "package.json" : `${cleaned}/package.json`);
    }
  }
  const sorted = [...projectFiles].sort(compareText);
  return {
    projectFiles: sorted.length === 0 ? ["package.json"] : sorted,
    excludeRoots: [...excludeRoots].sort(compareText),
  };
}

function deriveProjectJsonGlobs(relFiles: readonly string[]): readonly string[] {
  const depthsByTop = new Map<string, Set<number>>();
  let hasRootProjectJson = false;
  for (const rel of relFiles) {
    const parts = rel.split("/");
    const top = parts[0];
    if (parts.length === 1 || top === undefined) {
      hasRootProjectJson = true;
      continue;
    }
    const set = depthsByTop.get(top) ?? new Set<number>();
    set.add(parts.length);
    depthsByTop.set(top, set);
  }
  const patterns: string[] = hasRootProjectJson ? ["project.json"] : [];
  for (const [top, depths] of [...depthsByTop.entries()].sort(([a], [b]) => compareText(a, b))) {
    const singleLevel = depths.size === 1 && depths.has(3);
    patterns.push(singleLevel ? `${top}/*/project.json` : `${top}/**/project.json`);
  }
  return patterns;
}

function collectNamedFiles(workspaceRoot: string, prefix: string, fileName: string): string[] {
  const entries = readEntriesSafe(prefix === "" ? workspaceRoot : join(workspaceRoot, prefix));
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!ignoredWalkDirs.has(entry.name)) found.push(...collectNamedFiles(workspaceRoot, rel, fileName));
    } else if (entry.isFile() && entry.name === fileName) {
      found.push(rel);
    }
  }
  return found.sort(compareText);
}

function readEntriesSafe(directory: string): readonly Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readScannedProject(workspaceRoot: string, relFile: string): ScannedProject {
  const slash = relFile.lastIndexOf("/");
  const root = slash === -1 ? "." : relFile.slice(0, slash);
  const targets = readDeclaredTargetNames(join(workspaceRoot, relFile));
  return { root, targets };
}

function readDeclaredTargetNames(filePath: string): ReadonlySet<string> {
  const targets = new Set<string>();
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(readFileSync(filePath, "utf8")));
    if (!isRecord(parsed)) return targets;
    const source = isRecord(parsed["targets"]) ? parsed["targets"] : parsed["scripts"];
    if (!isRecord(source)) return targets;
    for (const key of Object.keys(source)) targets.add(key);
  } catch {
    // Unreadable project manifests are surfaced during native expansion.
  }
  return targets;
}

function stripRelativeSlashes(raw: string): string {
  let normalized = raw.trim();
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}
