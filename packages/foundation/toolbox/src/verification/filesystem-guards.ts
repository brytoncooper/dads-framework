/**
 * The filesystem guards every captured verification path passes through.
 *
 * A declared path is untrusted input: it may escape its root, name a symlink
 * that leaves the workspace, or arrive in a spelling that only looks
 * project-relative. These four checks are the whole answer, and they answer it
 * before any byte is read.
 */
import { existsSync, lstatSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";

/**
 * Resolves `projectPath` under `root`, refusing anything that lands outside it
 * or on it; `publish-verification-outputs.ts` has `resolveOutputInside`.
 */
export function resolveInside(root: string, projectPath: string): string {
  const absolutePath = resolve(root, projectPath);
  const pathFromRoot = relative(root, absolutePath);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    absolutePath === resolve(root)
  ) {
    throw new Error(`Verification path escapes its root: ${projectPath}.`);
  }
  return absolutePath;
}

/** Refuses a path whose every component is not a real, present, non-symlink entry. */
export function assertNoSymlinkComponents(
  root: string,
  projectPath: string,
): void {
  let currentPath = root;
  for (const component of projectPath.split("/")) {
    currentPath = join(currentPath, component);
    if (!existsSync(currentPath)) {
      throw new Error(`Verification input does not exist: ${projectPath}.`);
    }
    if (lstatSync(currentPath).isSymbolicLink()) {
      throw new Error(`Verification input contains a symlink: ${projectPath}.`);
    }
  }
}

export function normalizeRelativePath(value: string): string {
  if (value.includes("\\")) {
    throw new Error(`Verification paths must use forward slashes: ${value}.`);
  }
  const normalized = posix.normalize(value);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    throw new Error(`Expected a project-relative verification path: ${value}.`);
  }
  return normalized.replace(/^\.\//, "").replace(/\/$/, "");
}

export function normalizeWorkingDirectory(value: string): string {
  return value === "." ? "." : normalizeRelativePath(value);
}
