import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DiskObjectStorage,
  type DiskFreeSpace,
  type DiskObjectStorageLog,
} from "./disk-object-storage.js";

export const PREFIX = "/api/site/files";
export const GIB = 1024 ** 3;
export const PLENTY: DiskFreeSpace = () =>
  Promise.resolve({ freeBytes: 500 * GIB, totalBytes: 1000 * GIB });

type Logged = {
  readonly fields: Record<string, unknown>;
  readonly message: string;
};

export let root: string;
export let now: Date;
export let logged: Logged[];

export function recordingLog(): DiskObjectStorageLog {
  return {
    warn: (fields, message) => {
      logged.push({ fields, message });
    },
  };
}

export function storage(freeSpace: DiskFreeSpace = PLENTY): DiskObjectStorage {
  return new DiskObjectStorage({
    rootDirectory: root,
    signingKey: () => Promise.resolve(new Uint8Array(32).fill(7)),
    publicPathPrefix: PREFIX,
    clock: () => now,
    freeSpace,
    log: recordingLog(),
  });
}

export function advanceClock(milliseconds: number): void {
  now = new Date(now.getTime() + milliseconds);
}

export async function prepareDiskObjectStorageFixture(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), "disk-object-storage-"));
  now = new Date("2026-11-06T12:00:00.000Z");
  logged = [];
}

export async function removeDiskObjectStorageFixture(): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
