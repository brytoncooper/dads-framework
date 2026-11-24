import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeNxProcess } from "./nx-native-process.js";

export type EphemeralNxSnapshot = {
  readonly snapshotRoot: string;
  readonly revision: string;
};

/**
 * Runs a read-only callback inside an isolated detached Git worktree at `revision`
 * under `os.tmpdir()`, linking `node_modules` entries while keeping scratch physical
 * inside the snapshot so live-checkout edits cannot disturb discovery or planning.
 */
export async function withEphemeralNxSnapshot<T>(
  workspaceRoot: string,
  revision: string,
  callback: (snapshot: EphemeralNxSnapshot) => Promise<T>,
): Promise<T> {
  const resolved = await resolveSnapshotRevision(workspaceRoot, revision);
  const gitTopLevel = await fs.realpath(
    (await nativeNxProcess("git", ["rev-parse", "--show-toplevel"], workspaceRoot)).trim(),
  );
  const relativeWorkspace = path.relative(gitTopLevel, workspaceRoot);
  const container = await fs.mkdtemp(path.join(tmpdir(), "dads-nx-snapshot-"));
  const worktreeRoot = path.join(container, "worktree");
  const linkedDirs: string[] = [];
  try {
    await nativeNxProcess("git", ["worktree", "add", "--detach", worktreeRoot, resolved], gitTopLevel);
    const snapshotRoot = relativeWorkspace === "" ? worktreeRoot : path.join(worktreeRoot, relativeWorkspace);
    await linkSnapshotNodeModules(gitTopLevel, worktreeRoot, linkedDirs);
    if (relativeWorkspace !== "") {
      await linkSnapshotNodeModules(workspaceRoot, snapshotRoot, linkedDirs);
    }
    return await callback({ snapshotRoot: await fs.realpath(snapshotRoot), revision: resolved });
  } finally {
    await cleanupEphemeralSnapshot(gitTopLevel, worktreeRoot, container, linkedDirs);
  }
}

/** Returns true when `workspaceRoot` is inside a Git repository with a resolvable commit for `revision`. */
export async function hasSnapshotRevision(workspaceRoot: string, revision: string): Promise<boolean> {
  try {
    await resolveSnapshotRevision(workspaceRoot, revision);
    return true;
  } catch {
    return false;
  }
}

/** Returns true when `workspaceRoot` has no uncommitted or untracked Git changes. */
export async function isCleanWorkingTree(workspaceRoot: string): Promise<boolean> {
  try {
    const status = await nativeNxProcess("git", ["status", "--porcelain"], workspaceRoot);
    return status.trim() === "";
  } catch {
    return false;
  }
}

async function resolveSnapshotRevision(workspaceRoot: string, revision: string): Promise<string> {
  const stdout = await nativeNxProcess(
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
    workspaceRoot,
  );
  return stdout.trim();
}

async function linkSnapshotNodeModules(sourceRoot: string, targetRoot: string, linkedDirs: string[]): Promise<void> {
  const sourceModules = path.join(sourceRoot, "node_modules");
  const realSource = await resolveDirectory(sourceModules);
  if (realSource === undefined) return;
  const targetModules = path.join(targetRoot, "node_modules");
  await fs.mkdir(targetModules, { recursive: true });
  linkedDirs.push(targetModules);
  const entries = await fs.readdir(realSource);
  await Promise.all(entries.map((entry) => linkNodeModulesEntry(realSource, targetModules, entry)));
}

async function linkNodeModulesEntry(sourceModules: string, targetModules: string, entry: string): Promise<void> {
  if (entry === ".cache") return;
  const destination = path.join(targetModules, entry);
  if (await pathExists(destination)) return;
  const source = path.join(sourceModules, entry);
  const linkType = await symlinkTypeFor(source);
  await fs.symlink(source, destination, linkType);
}

async function symlinkTypeFor(source: string): Promise<"junction" | "file" | undefined> {
  if (process.platform !== "win32") return undefined;
  const stats = await fs.stat(source);
  return stats.isDirectory() ? "junction" : "file";
}

async function resolveDirectory(candidate: string): Promise<string | undefined> {
  try {
    const resolved = await fs.realpath(candidate);
    const stats = await fs.stat(resolved);
    return stats.isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function cleanupEphemeralSnapshot(
  gitTopLevel: string,
  worktreeRoot: string,
  container: string,
  linkedDirs: readonly string[],
): Promise<void> {
  await Promise.all(linkedDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)));
  await nativeNxProcess("git", ["worktree", "remove", "--force", worktreeRoot], gitTopLevel).catch(() => undefined);
  await fs.rm(container, { recursive: true, force: true }).catch(() => undefined);
  await nativeNxProcess("git", ["worktree", "prune"], gitTopLevel).catch(() => undefined);
}
