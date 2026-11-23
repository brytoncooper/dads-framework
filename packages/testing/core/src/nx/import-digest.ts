/**
 * The evidence an import was taken over one exact set of bytes.
 *
 * A manifest is only reproducible if the inputs it was derived from can be
 * recognized again, so every file that can change the answer — the lockfile,
 * `nx.json`, and each project's own configuration — is hashed and recorded. A
 * file that is simply absent is not evidence of anything and is skipped; any
 * other read failure is a real failure and is raised.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DigestedInput } from "./import-nx-types.js";
import { isMissingFile, normalizeRoot } from "./nx-workspace-reader.js";

/** Workspace-level files, in the order the report lists them. */
const workspaceInputNames = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "nx.json",
  "workspace.json",
  "package.json",
];

/** Per-project files that can change what a project's targets mean. */
const projectInputNames = ["project.json", "package.json"];

/** The hex SHA-256 of `value`. */
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Digests the workspace-level files that exist. */
export async function digestInputs(workspaceRoot: string): Promise<readonly DigestedInput[]> {
  const entries: DigestedInput[] = [];
  for (const name of workspaceInputNames) {
    const digested = await digestOptionalFile(workspaceRoot, name);
    if (digested) entries.push(digested);
  }
  return entries;
}

/**
 * Adds each project's own configuration files to `rootInputs`, keyed by path
 * so a project rooted at the workspace root cannot record `package.json`
 * twice, and returns the whole set sorted by path.
 */
export async function digestProjectInputs(
  workspaceRoot: string,
  rootInputs: readonly DigestedInput[],
  projectRoots: readonly string[],
): Promise<readonly DigestedInput[]> {
  const entries = new Map(rootInputs.map((entry) => [entry.path, entry]));
  for (const root of projectRoots) {
    for (const name of projectInputNames) {
      const relative = normalizeRoot(path.posix.join(root, name));
      const digested = await digestOptionalFile(workspaceRoot, relative);
      if (digested) entries.set(relative, digested);
    }
  }
  return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
}

/** Digests one workspace-relative file, or `undefined` when it is absent. */
async function digestOptionalFile(workspaceRoot: string, relativePath: string): Promise<DigestedInput | undefined> {
  try {
    const contents = await fs.readFile(path.join(workspaceRoot, relativePath));
    return { path: relativePath, sha256: sha256(contents) };
  } catch (error: unknown) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}
