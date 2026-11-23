import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { ShippedDatabaseMigrationFile } from "./domain-migration.js";
import { fileSha256 } from "./migration-checksum.js";
import type { MigrationSource, MigrationWorkspace } from "./migration-workspace.js";

/**
 * Where migration files live and what each one's path says — owner, journal
 * name, timestamp id — read without loading any module. Split from discovery
 * so a reader (the API's status page) can list what a build ships without
 * pulling the runner's module loader and node-pg-migrate into its bundle.
 */

const MIGRATION_FILE_NAME = /^(\d{14})_[a-z0-9_]+\.migration\.ts$/;

/**
 * Every database migration file this build ships, in identity order, WITHOUT
 * loading its module — the same walk, owner and journal name the runner
 * uses, checksummed the way the runner checksums it. For reporting what a
 * deployment ran; `discoverDomainMigrations` remains the runner's only door.
 * A missing library root throws, exactly as it does for the runner.
 */
export async function listShippedDatabaseMigrations(
  workspace: MigrationWorkspace,
): Promise<ShippedDatabaseMigrationFile[]> {
  const relativePaths = (await listMigrationRelativePaths(workspace)).toSorted(
    (left, right) =>
      idFromFileName(left).localeCompare(idFromFileName(right)) ||
      journalNameFromRelativePath(left).localeCompare(journalNameFromRelativePath(right)),
  );
  return Promise.all(
    relativePaths.map(async (relativePath) => ({
      journalName: journalNameFromRelativePath(relativePath),
      owner: ownerFromRelativePath(workspace, relativePath),
      file: relativePath,
      sha256: await fileSha256(join(workspace.root, relativePath)),
    })),
  );
}

/**
 * Every migration file under the workspace's sources, relative to its root.
 * A missing required source throws rather than reading as "nothing to apply":
 * the runner would otherwise apply nothing and log success.
 */
export async function listMigrationRelativePaths(workspace: MigrationWorkspace): Promise<string[]> {
  const files: string[] = [];
  for (const source of workspace.sources) {
    const directory = join(workspace.root, source.root);
    if (!(await directoryExists(directory))) {
      if (!source.required) continue;
      throw new Error(
        `migration discovery: ${source.root} does not exist under ${workspace.root}. ` +
          `Every migration this runner applies lives under one of ` +
          `${workspace.sources.map((it) => it.root).join(", ")}, so a missing ` +
          `root would leave the database unmigrated while the run reported success.`,
      );
    }
    await walkDirectory(workspace.root, directory, files);
  }
  return files.filter((relativePath) => sourceOf(workspace, relativePath) !== undefined);
}

function sourceOf(workspace: MigrationWorkspace, relativePath: string): MigrationSource | undefined {
  return workspace.sources.find((source) => source.files.test(relativePath));
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    await readdir(directory);
    return true;
  } catch {
    return false;
  }
}

async function walkDirectory(workspaceRoot: string, directory: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walkDirectory(workspaceRoot, entryPath, files);
        return;
      }
      if (entry.isFile() && entry.name.endsWith(".migration.ts")) {
        files.push(toPosixPath(relative(workspaceRoot, entryPath)));
      }
    }),
  );
}

export function ownerFromRelativePath(workspace: MigrationWorkspace, relativePath: string): string {
  const source = sourceOf(workspace, relativePath);
  if (source?.owner !== undefined) return source.owner;
  const owner = source?.files.exec(relativePath)?.[1];
  if (owner !== undefined) return owner;
  throw new Error(`migration ${relativePath} is not under an owner folder`);
}

export function journalNameFromRelativePath(relativePath: string): string {
  const fileName = relativePath.split("/").at(-1);
  if (fileName === undefined || !fileName.endsWith(".ts")) {
    throw new Error(`migration ${relativePath} has no TypeScript filename`);
  }
  return fileName.slice(0, -".ts".length);
}

export function idFromFileName(relativePath: string): string {
  const fileName = relativePath.split("/").at(-1);
  if (fileName === undefined) {
    throw new Error(`migration ${relativePath} has no filename`);
  }
  const match = MIGRATION_FILE_NAME.exec(fileName);
  if (match?.[1] === undefined) {
    throw new Error(`migration ${relativePath} must be named <utcTimestamp>_<slug>.migration.ts`);
  }
  return match[1];
}

function toPosixPath(filePath: string): string {
  return filePath.split(sep).join("/");
}
