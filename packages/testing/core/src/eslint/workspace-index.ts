/**
 * Zero-Nx workspace project and alias index for module-boundary linting.
 * Reads `project.json` tags/buildability, `tsconfig.base.json` /
 * `tsconfig.paths.json` path mappings, and ancestor `package.json` manifests.
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { dirname, resolve } from "node:path";
import { isRecord, isUnknownArray } from "../parse-guards.js";

const skipDirs = new Set([".git", ".nx", "coverage", "dist", "node_modules", "tmp"]);
const declaredDepFields: readonly string[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

export type BoundaryProject = {
  readonly name: string;
  readonly root: string;
  readonly tags: readonly string[];
  readonly projectType: string;
  readonly isBuildable: boolean;
};

export type WorkspaceBoundaryIndex = {
  readonly workspaceRoot: string;
  readonly projects: readonly BoundaryProject[];
  readonly findProjectForRelPath: (relPath: string) => BoundaryProject | undefined;
  readonly resolveAliasTarget: (specifier: string) => BoundaryProject | undefined;
  readonly isDeclaredForFile: (absFilePath: string, packageName: string) => boolean;
  readonly hasDependencyPath: (fromProject: string, toProject: string) => boolean;
};

type WildcardAlias = { readonly prefix: string; readonly targetPrefix: string };

const boundaryIndexCache = new Map<string, WorkspaceBoundaryIndex>();

/** Walks upward from `startDir` to locate the workspace root (`tsconfig.base.json` + `package.json`). */
export function findBoundaryWorkspaceRoot(startDir: string): string {
  let cursor = resolve(startDir);
  for (;;) {
    if (existsSync(resolve(cursor, "tsconfig.base.json")) && existsSync(resolve(cursor, "package.json"))) {
      return cursor;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return resolve(startDir);
    cursor = parent;
  }
}

/** Returns a process-cached `WorkspaceBoundaryIndex` for `workspaceRoot`. */
export function getCachedWorkspaceBoundaryIndex(workspaceRoot: string): WorkspaceBoundaryIndex {
  const cached = boundaryIndexCache.get(workspaceRoot);
  if (cached !== undefined) return cached;
  const loaded = loadWorkspaceBoundaryIndex(workspaceRoot);
  boundaryIndexCache.set(workspaceRoot, loaded);
  return loaded;
}

/** Scans `workspaceRoot` for `project.json` files and TypeScript path aliases. */
export function loadWorkspaceBoundaryIndex(workspaceRoot: string): WorkspaceBoundaryIndex {
  const projects = loadBoundaryProjects(workspaceRoot);
  const { exactAliases, wildcardAliases } = loadBoundaryAliases(workspaceRoot);
  const rootDeclared = loadDeclaredDeps(resolve(workspaceRoot, "package.json"));
  const packageJsonCache = new Map<string, ReadonlySet<string>>();
  let projectGraph: Map<string, Set<string>> | undefined;
  const reachCache = new Map<string, boolean>();

  const findProjectForRelPath = (relPath: string): BoundaryProject | undefined =>
    matchDeepestProject(projects, relPath);
  const resolveAliasTarget = (specifier: string): BoundaryProject | undefined =>
    lookupAliasProject(specifier, exactAliases, wildcardAliases, findProjectForRelPath);
  const isDeclaredForFile = (absFilePath: string, packageName: string): boolean =>
    checkDeclaredInAncestors(workspaceRoot, rootDeclared, packageJsonCache, absFilePath, packageName);
  const hasDependencyPath = (fromProject: string, toProject: string): boolean => {
    projectGraph ??= buildBoundaryProjectGraph(workspaceRoot, projects, resolveAliasTarget);
    return checkReachability(projectGraph, reachCache, fromProject, toProject);
  };

  return { workspaceRoot, projects, findProjectForRelPath, resolveAliasTarget, isDeclaredForFile, hasDependencyPath };
}

function stripBoundaryJsonComments(text: string): string {
  return text.replace(/\\"|"(?:\\"|[^"])*"|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g, (match, comment: unknown) =>
    typeof comment === "string" && comment.length > 0 ? "" : match,
  );
}

function readBoundaryJsonc(filePath: string): unknown {
  return JSON.parse(stripBoundaryJsonComments(readFileSync(filePath, "utf8")));
}

function loadBoundaryProjects(workspaceRoot: string): readonly BoundaryProject[] {
  const files = collectProjectFiles(workspaceRoot, "", []);
  const projects: BoundaryProject[] = [];
  for (const relFile of files) {
    const project = parseBoundaryProject(workspaceRoot, relFile);
    if (project !== undefined) projects.push(project);
  }
  projects.sort((a, b) => {
    if (a.root === ".") return 1;
    if (b.root === ".") return -1;
    return b.root.length - a.root.length;
  });
  return projects;
}

function parseBoundaryProject(workspaceRoot: string, relFile: string): BoundaryProject | undefined {
  let raw: unknown;
  try {
    raw = readBoundaryJsonc(resolve(workspaceRoot, relFile));
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || typeof raw["name"] !== "string") return undefined;
  const root = relFile === "project.json" ? "." : relFile.slice(0, -"/project.json".length);
  const tags = isUnknownArray(raw["tags"]) ? raw["tags"].filter((t): t is string => typeof t === "string") : [];
  const projectType = typeof raw["projectType"] === "string" ? raw["projectType"] : "library";
  const targets = raw["targets"];
  const isBuildable = isRecord(targets) && isRecord(targets["build"]);
  return { name: raw["name"], root, tags, projectType, isBuildable };
}

function collectProjectFiles(rootDir: string, relDir: string, out: string[]): string[] {
  const absDir = relDir === "" ? rootDir : resolve(rootDir, relDir);
  const entries = safeReadDirEntries(absDir);
  for (const entry of entries) {
    const childRel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
    if (entry.name === "project.json" && entry.isFile()) {
      out.push(childRel);
    } else if (shouldDescendProjectDir(entry.isDirectory(), entry.name, relDir)) {
      collectProjectFiles(rootDir, childRel, out);
    }
  }
  return out;
}

function shouldDescendProjectDir(isDir: boolean, name: string, relDir: string): boolean {
  if (!isDir || skipDirs.has(name)) return false;
  return !(name.startsWith(".") && relDir === "");
}

function safeReadDirEntries(absDir: string): readonly Dirent[] {
  try {
    return readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function loadBoundaryAliases(workspaceRoot: string): {
  readonly exactAliases: ReadonlyMap<string, string>;
  readonly wildcardAliases: readonly WildcardAlias[];
} {
  const paths = readMergedTsconfigPaths(workspaceRoot);
  const exactAliases = new Map<string, string>();
  const wildcardAliases: WildcardAlias[] = [];
  for (const [alias, target] of paths) {
    const clean = target.replace(/^\.\//, "");
    if (alias.includes("*")) {
      const star = alias.indexOf("*");
      wildcardAliases.push({ prefix: alias.slice(0, star), targetPrefix: clean.replace(/\*.*$/, "") });
    } else {
      exactAliases.set(alias, clean);
    }
  }
  wildcardAliases.sort((a, b) => b.prefix.length - a.prefix.length);
  return { exactAliases, wildcardAliases };
}

function readMergedTsconfigPaths(workspaceRoot: string): Map<string, string> {
  const merged = new Map<string, string>();
  for (const candidate of ["tsconfig.base.json", "tsconfig.paths.json"]) {
    mergeTsconfigFilePaths(resolve(workspaceRoot, candidate), merged);
  }
  return merged;
}

function mergeTsconfigFilePaths(absPath: string, merged: Map<string, string>): void {
  if (!existsSync(absPath)) return;
  let parsed: unknown;
  try {
    parsed = readBoundaryJsonc(absPath);
  } catch {
    return;
  }
  const compilerOptions = isRecord(parsed) ? parsed["compilerOptions"] : undefined;
  const rawPaths = isRecord(compilerOptions) ? compilerOptions["paths"] : undefined;
  if (!isRecord(rawPaths)) return;
  for (const [alias, targets] of Object.entries(rawPaths)) {
    if (isUnknownArray(targets) && typeof targets[0] === "string") merged.set(alias, targets[0]);
  }
}

function matchDeepestProject(projects: readonly BoundaryProject[], relPath: string): BoundaryProject | undefined {
  const clean = relPath.replaceAll("\\", "/").replace(/^\.\//, "");
  for (const project of projects) {
    if (project.root === ".") return project;
    if (clean === project.root || clean.startsWith(`${project.root}/`)) return project;
  }
  return undefined;
}

function lookupAliasProject(
  specifier: string,
  exactAliases: ReadonlyMap<string, string>,
  wildcardAliases: readonly WildcardAlias[],
  findProject: (relPath: string) => BoundaryProject | undefined,
): BoundaryProject | undefined {
  const exact = exactAliases.get(specifier);
  if (exact !== undefined) return findProject(exact);
  for (const entry of wildcardAliases) {
    if (specifier.startsWith(entry.prefix)) {
      return findProject(`${entry.targetPrefix}${specifier.slice(entry.prefix.length)}`);
    }
  }
  return undefined;
}

function loadDeclaredDeps(pkgJsonPath: string): ReadonlySet<string> {
  if (!existsSync(pkgJsonPath)) return new Set();
  const parsed: unknown = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  if (!isRecord(parsed)) return new Set();
  const declared = new Set<string>();
  for (const field of declaredDepFields) {
    const section = parsed[field];
    if (!isRecord(section)) continue;
    for (const name of Object.keys(section)) declared.add(name);
  }
  return declared;
}

function checkDeclaredInAncestors(
  workspaceRoot: string,
  rootDeclared: ReadonlySet<string>,
  cache: Map<string, ReadonlySet<string>>,
  absFilePath: string,
  packageName: string,
): boolean {
  if (rootDeclared.has(packageName)) return true;
  let cursor = dirname(absFilePath);
  while (cursor.startsWith(workspaceRoot) && cursor !== workspaceRoot) {
    const candidate = resolve(cursor, "package.json");
    let declared = cache.get(candidate);
    if (declared === undefined) {
      declared = loadDeclaredDeps(candidate);
      cache.set(candidate, declared);
    }
    if (declared.has(packageName)) return true;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return false;
}

function buildBoundaryProjectGraph(
  workspaceRoot: string,
  projects: readonly BoundaryProject[],
  resolveAliasTarget: (specifier: string) => BoundaryProject | undefined,
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const project of projects) {
    if (project.root === ".") continue;
    const srcDir = resolve(workspaceRoot, project.root, "src");
    const scanRoot = existsSync(srcDir) ? srcDir : resolve(workspaceRoot, project.root);
    graph.set(project.name, scanProjectAliasDeps(scanRoot, project.name, resolveAliasTarget));
  }
  return graph;
}

function scanProjectAliasDeps(
  scanRoot: string,
  projectName: string,
  resolveAliasTarget: (specifier: string) => BoundaryProject | undefined,
): Set<string> {
  const deps = new Set<string>();
  for (const file of collectBoundarySourceFiles(scanRoot, [])) {
    collectFileAliasDeps(file, projectName, resolveAliasTarget, deps);
  }
  return deps;
}

function collectFileAliasDeps(
  file: string,
  projectName: string,
  resolveAliasTarget: (specifier: string) => BoundaryProject | undefined,
  deps: Set<string>,
): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  const importRe = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
  for (let match = importRe.exec(text); match !== null; match = importRe.exec(text)) {
    const spec = (match[1] ?? "").split("?")[0] ?? "";
    if (spec.length === 0 || spec.startsWith(".") || spec.startsWith("/")) continue;
    const target = resolveAliasTarget(spec);
    if (target !== undefined && target.name !== projectName) deps.add(target.name);
  }
}

function collectBoundarySourceFiles(absDir: string, out: string[]): string[] {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name) && !entry.name.startsWith(".")) {
        collectBoundarySourceFiles(resolve(absDir, entry.name), out);
      }
      continue;
    }
    if (entry.isFile() && isBoundarySourceFileName(entry.name)) out.push(resolve(absDir, entry.name));
  }
  return out;
}

function isBoundarySourceFileName(name: string): boolean {
  return (
    /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(name) &&
    !/\.(?:test|spec)\.[^.]+$/.test(name) &&
    !name.endsWith(".d.ts")
  );
}

function checkReachability(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  cache: Map<string, boolean>,
  fromProject: string,
  toProject: string,
): boolean {
  if (fromProject === toProject) return true;
  const key = `${fromProject}->${toProject}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const found = bfsReaches(graph, fromProject, toProject);
  cache.set(key, found);
  return found;
}

function bfsReaches(graph: ReadonlyMap<string, ReadonlySet<string>>, fromProject: string, toProject: string): boolean {
  const visited = new Set<string>([fromProject]);
  const queue = [fromProject];
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i];
    if (current === undefined) continue;
    for (const next of graph.get(current) ?? []) {
      if (next === toProject) return true;
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}
