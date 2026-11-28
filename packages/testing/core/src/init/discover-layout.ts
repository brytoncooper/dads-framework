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
  const nxIgnores = readNxIgnorePatterns(workspaceRoot);
  const nxProjectFiles = collectNamedFiles(workspaceRoot, "", "project.json", nxIgnores);
  if (nxProjectFiles.length > 0) {
    return buildNxLayout(workspaceRoot, detected, nxProjectFiles, nxIgnores);
  }
  return buildPackageJsonLayout(workspaceRoot, detected, nxIgnores);
}

function buildNxLayout(
  workspaceRoot: string,
  detected: DetectedWorkspace,
  relFiles: readonly string[],
  nxIgnores: readonly string[],
): WorkspaceLayout {
  const projects: ScannedProject[] = [];
  const seenRoots = new Set<string>();
  const combinedFiles = new Set<string>(deriveProjectJsonGlobs(relFiles));
  const combinedExcludes = new Set<string>(nxIgnores);
  for (const relFile of relFiles) {
    const scanned = readScannedProject(workspaceRoot, relFile);
    if (scanned.valid) {
      projects.push(scanned.project);
      seenRoots.add(scanned.project.root);
    } else if (scanned.project.root !== ".") {
      combinedExcludes.add(scanned.project.root);
    }
  }
  if (detected.patterns.length > 0) {
    mergeWorkspacePackagesIntoNxLayout(
      workspaceRoot,
      detected,
      nxIgnores,
      seenRoots,
      projects,
      combinedFiles,
      combinedExcludes,
    );
  }
  mergeNestedUnownedPackageDirs(workspaceRoot, relFiles, nxIgnores, seenRoots, projects, combinedFiles);
  return {
    kind: "nx-project-json",
    packageManager: detected.packageManager,
    projectFiles: [...combinedFiles].sort(compareText),
    excludeRoots: [...combinedExcludes].sort(compareText),
    projects,
  };
}

function mergeWorkspacePackagesIntoNxLayout(
  workspaceRoot: string,
  detected: DetectedWorkspace,
  nxIgnores: readonly string[],
  seenRoots: Set<string>,
  projects: ScannedProject[],
  combinedFiles: Set<string>,
  combinedExcludes: Set<string>,
): void {
  const pkgTranslated = translateWorkspacePatterns(detected.patterns);
  for (const pat of pkgTranslated.projectFiles) {
    if (pat !== "package.json" || !combinedFiles.has("project.json")) combinedFiles.add(pat);
  }
  for (const ex of pkgTranslated.excludeRoots) combinedExcludes.add(ex);
  for (const directory of detected.packageDirectories) {
    if (seenRoots.has(directory) || matchesNxIgnore(directory, nxIgnores)) continue;
    recordScannedProject(
      workspaceRoot,
      directory === "." ? "package.json" : `${directory}/package.json`,
      seenRoots,
      projects,
      combinedExcludes,
    );
  }
}

const nestedPackageSkipDirs = new Set(["fixtures", "__fixtures__", "templates", "examples", "node_modules", "dist"]);

function mergeNestedUnownedPackageDirs(
  workspaceRoot: string,
  nxProjectFiles: readonly string[],
  nxIgnores: readonly string[],
  seenRoots: Set<string>,
  projects: ScannedProject[],
  combinedFiles: Set<string>,
): void {
  const topDirs = new Set<string>();
  for (const rel of nxProjectFiles) {
    const slash = rel.indexOf("/");
    if (slash > 0) topDirs.add(rel.slice(0, slash));
  }
  for (const top of topDirs) {
    for (const child of readEntriesSafe(join(workspaceRoot, top))) {
      if (!child.isDirectory() || child.isSymbolicLink()) continue;
      const childRel = `${top}/${child.name}`;
      if (ignoredWalkDirs.has(child.name) || seenRoots.has(childRel) || matchesNxIgnore(childRel, nxIgnores)) continue;
      scanNestedPackageApps(workspaceRoot, childRel, 2, nxIgnores, seenRoots, projects, combinedFiles);
    }
  }
}

function scanNestedPackageApps(
  workspaceRoot: string,
  prefix: string,
  depthLeft: number,
  nxIgnores: readonly string[],
  seenRoots: Set<string>,
  projects: ScannedProject[],
  combinedFiles: Set<string>,
): void {
  if (depthLeft === 0) return;
  for (const entry of readEntriesSafe(join(workspaceRoot, prefix))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (ignoredWalkDirs.has(entry.name) || nestedPackageSkipDirs.has(entry.name)) continue;
    const rel = `${prefix}/${entry.name}`;
    if (seenRoots.has(rel) || matchesNxIgnore(rel, nxIgnores)) continue;
    const pkgRel = `${rel}/package.json`;
    const scanned = readScannedProject(workspaceRoot, pkgRel);
    if (scanned.valid) {
      projects.push(scanned.project);
      seenRoots.add(rel);
      combinedFiles.add(pkgRel);
    } else {
      scanNestedPackageApps(workspaceRoot, rel, depthLeft - 1, nxIgnores, seenRoots, projects, combinedFiles);
    }
  }
}

function recordScannedProject(
  workspaceRoot: string,
  relFile: string,
  seenRoots: Set<string>,
  projects: ScannedProject[],
  excludes: Set<string>,
): void {
  const scanned = readScannedProject(workspaceRoot, relFile);
  if (scanned.valid) {
    projects.push(scanned.project);
    seenRoots.add(scanned.project.root);
  } else if (scanned.project.root !== ".") {
    excludes.add(scanned.project.root);
  }
}

function buildPackageJsonLayout(
  workspaceRoot: string,
  detected: DetectedWorkspace,
  nxIgnores: readonly string[],
): WorkspaceLayout {
  const { projectFiles, excludeRoots } = translateWorkspacePatterns(detected.patterns);
  const projects: ScannedProject[] = [];
  const invalidRoots: string[] = [];
  for (const directory of detected.packageDirectories) {
    if (matchesNxIgnore(directory, nxIgnores)) continue;
    const relFile = directory === "." ? "package.json" : `${directory}/package.json`;
    const scanned = readScannedProject(workspaceRoot, relFile);
    if (scanned.valid) projects.push(scanned.project);
    else if (scanned.project.root !== ".") invalidRoots.push(scanned.project.root);
  }
  return {
    kind: "package-json",
    packageManager: detected.packageManager,
    projectFiles,
    excludeRoots: [...new Set([...excludeRoots, ...nxIgnores, ...invalidRoots])].sort(compareText),
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

function collectNamedFiles(
  workspaceRoot: string,
  prefix: string,
  fileName: string,
  nxIgnores: readonly string[],
): string[] {
  const entries = readEntriesSafe(prefix === "" ? workspaceRoot : join(workspaceRoot, prefix));
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!ignoredWalkDirs.has(entry.name) && !matchesNxIgnore(rel, nxIgnores)) {
        found.push(...collectNamedFiles(workspaceRoot, rel, fileName, nxIgnores));
      }
    } else if (entry.isFile() && entry.name === fileName) {
      found.push(rel);
    }
  }
  return found.sort(compareText);
}

function readNxIgnorePatterns(workspaceRoot: string): readonly string[] {
  try {
    const raw = readFileSync(join(workspaceRoot, ".nxignore"), "utf8");
    const patterns = new Set<string>();
    for (const line of raw.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
      const cleaned = stripRelativeSlashes(trimmed);
      if (cleaned.length > 0) patterns.add(cleaned);
    }
    return [...patterns].sort(compareText);
  } catch {
    return [];
  }
}

function matchesNxIgnore(relPath: string, nxIgnores: readonly string[]): boolean {
  if (nxIgnores.length === 0) return false;
  const segments = relPath.split("/");
  for (const pattern of nxIgnores) {
    if (relPath === pattern || relPath.startsWith(`${pattern}/`)) return true;
    if (!pattern.includes("/") && !pattern.includes("*") && segments.includes(pattern)) return true;
  }
  return false;
}

function readEntriesSafe(directory: string): readonly Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readScannedProject(
  workspaceRoot: string,
  relFile: string,
): { readonly valid: boolean; readonly project: ScannedProject } {
  const slash = relFile.lastIndexOf("/");
  const root = slash === -1 ? "." : relFile.slice(0, slash);
  const { valid, targets } = readDeclaredTargetNames(join(workspaceRoot, relFile));
  return { valid, project: { root, targets } };
}

function readDeclaredTargetNames(filePath: string): {
  readonly valid: boolean;
  readonly targets: ReadonlySet<string>;
} {
  const targets = new Set<string>();
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(readFileSync(filePath, "utf8")));
    if (!isRecord(parsed)) return { valid: false, targets };
    const source = isRecord(parsed["targets"]) ? parsed["targets"] : parsed["scripts"];
    if (isRecord(source)) {
      for (const key of Object.keys(source)) targets.add(key);
    }
    return { valid: true, targets };
  } catch {
    return { valid: false, targets };
  }
}

function stripRelativeSlashes(raw: string): string {
  let normalized = raw.trim();
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}
