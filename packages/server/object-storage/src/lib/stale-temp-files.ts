import type { Dirent, Stats } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { TEMP_MARKER } from "./disk-files.js";

/** The file-system calls the sweep makes; Node's own on a box, a failing fake in tests. */
export type SweepFileSystem = {
  readonly readdir: (folder: string) => Promise<Dirent[]>;
  readonly stat: (path: string) => Promise<Stats>;
  readonly rm: (path: string) => Promise<void>;
};

export const NODE_SWEEP_FILE_SYSTEM: SweepFileSystem = {
  readdir: (folder) => readdir(folder, { withFileTypes: true }),
  stat: (path) => stat(path),
  rm: (path) => rm(path, { force: true }),
};

/** What one sweep did. `failedSample` is one path (relative to the root) it could not list or remove. */
export type StaleTempFileSweep = {
  readonly removed: number;
  readonly failed: number;
  readonly failedSample: string | null;
};

/**
 * Removes every `*.tmp-*` file under `root` last written before `before`:
 * what a crash or power cut left between a temp write and its rename. A
 * younger one may belong to a write still running, so it stays.
 *
 * Best effort, and never throws: a folder it cannot list or a file it cannot
 * stat or remove is counted in `failed` and skipped, and every other stale
 * file is still removed. A file or folder gone meanwhile is not a failure.
 */
export async function removeStaleTempFiles(
  root: string,
  before: number,
  fileSystem: SweepFileSystem = NODE_SWEEP_FILE_SYSTEM,
): Promise<StaleTempFileSweep> {
  const sweep = new Sweep(root, before, fileSystem);
  await sweep.run();
  return sweep.result();
}

class Sweep {
  private removed = 0;
  private failed = 0;
  private failedSample: string | null = null;
  private readonly folders: string[];

  constructor(
    private readonly root: string,
    private readonly before: number,
    private readonly fileSystem: SweepFileSystem,
  ) {
    this.folders = [root];
  }

  async run(): Promise<void> {
    let folder = this.folders.pop();
    while (folder !== undefined) {
      await this.sweepFolder(folder);
      folder = this.folders.pop();
    }
  }

  result(): StaleTempFileSweep {
    return {
      removed: this.removed,
      failed: this.failed,
      failedSample: this.failedSample,
    };
  }

  private async sweepFolder(folder: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await this.fileSystem.readdir(folder);
    } catch (error) {
      this.failUnlessGone(folder, error);
      return;
    }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) this.folders.push(path);
      else if (entry.isFile() && entry.name.includes(TEMP_MARKER)) await this.removeIfStale(path);
    }
  }

  private async removeIfStale(path: string): Promise<void> {
    try {
      const written = await this.fileSystem.stat(path);
      if (written.mtimeMs >= this.before) return;
      await this.fileSystem.rm(path);
      this.removed += 1;
    } catch (error) {
      this.failUnlessGone(path, error);
    }
  }

  private failUnlessGone(path: string, error: unknown): void {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    this.failed += 1;
    this.failedSample ??= path.slice(this.root.length + 1) || ".";
  }
}
