/**
 * The file-system steps `DiskObjectStorage` is built from: whole-or-absent
 * writes, reads that treat a missing file as null, the folder walk, the
 * volume's free space, and the box's signing key.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  statfs,
} from "node:fs/promises";
import { dirname, join } from "node:path";

/** Free and total bytes of the volume the root is on. */
export type DiskSpace = {
  readonly freeBytes: number;
  readonly totalBytes: number;
};

/** What a body's sidecar records. */
export type Sidecar = { readonly contentType: string; readonly sha256: string };

/** An object's file and its sidecar, read together. */
export type SettledFile = {
  readonly path: string;
  readonly sidecar: Sidecar;
};

/** Marks a file written but not yet renamed into place: never an object. */
export const TEMP_MARKER = ".tmp-";

const SIGNING_KEY_FILE = "signing-key";
const SIGNING_KEY_BYTES = 32;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Writes `<path>.tmp-<random>` and fsyncs it; the caller renames it into
 * place. The temp path is pushed to `written` before any byte, so the caller
 * can remove it whatever fails.
 */
export async function writeTemp(
  path: string,
  bytes: Uint8Array,
  written: string[],
): Promise<string> {
  const temp = `${path}${TEMP_MARKER}${randomBytes(6).toString("hex")}`;
  const handle = await open(temp, "wx", 0o640);
  written.push(temp);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temp;
}

/** Makes a rename in the folder durable across a power cut. */
export async function fsyncFolder(folder: string): Promise<void> {
  const handle = await open(folder, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * The folders a put must fsync so its file survives a power cut: the file's
 * own folder, and when `mkdir` made folders (`firstCreated` is the topmost
 * one it made), the parent of each, up to and including the folder that
 * holds `firstCreated`.
 */
export function foldersToSync(
  folder: string,
  firstCreated: string | undefined,
): string[] {
  const folders = [folder];
  if (firstCreated === undefined) return folders;
  const top = dirname(firstCreated);
  let current = folder;
  while (current !== top && dirname(current) !== current) {
    current = dirname(current);
    folders.push(current);
  }
  return folders;
}

/** `fsyncFolder`, except a folder that does not exist has nothing to sync. */
export async function fsyncFolderIfPresent(folder: string): Promise<void> {
  try {
    await fsyncFolder(folder);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

export async function readIfPresent(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

/** An object's size and content type, as `DiskObjectStorage.head` answers. */
export type DiskObjectHead = {
  readonly byteSize: number;
  readonly contentType: string;
};

/** The file's size from its directory entry, with the sidecar's content type; null when the file is missing. */
export async function headOfFile(
  path: string,
  sidecar: Sidecar,
): Promise<DiskObjectHead | null> {
  try {
    const { size } = await stat(path);
    return { byteSize: size, contentType: sidecar.contentType };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

/** The file's first `byteCount` bytes (fewer for a shorter file), never the rest; null when it is missing. */
export async function readPrefixIfPresent(
  path: string,
  byteCount: number,
): Promise<Uint8Array | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  try {
    const buffer = new Uint8Array(Math.max(0, byteCount));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The sidecar at `path`; null when it is missing or not a sidecar. */
export async function readSidecar(path: string): Promise<Sidecar | null> {
  const bytes = await readIfPresent(path);
  if (bytes === null) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isSidecar(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Every file under the folder, as `/`-joined paths relative to it; none when it is missing. */
export async function listFilesUnder(folder: string): Promise<string[]> {
  try {
    const entries = await readdir(folder, {
      recursive: true,
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        join(entry.parentPath, entry.name)
          .slice(folder.length + 1)
          .split("\\")
          .join("/"),
      );
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

/**
 * The bytes of every file under `folder`, bodies and sidecars alike; 0 when
 * it does not exist. A file removed during the walk counts as 0.
 */
export async function bytesUnder(folder: string): Promise<number> {
  let total = 0;
  for (const relative of await listFilesUnder(folder)) {
    try {
      total += (await stat(join(folder, relative))).size;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  return total;
}

export async function readVolumeSpace(directory: string): Promise<DiskSpace> {
  const stats = await statfs(directory);
  return {
    freeBytes: stats.bavail * stats.bsize,
    totalBytes: stats.blocks * stats.bsize,
  };
}

/**
 * The box's signing key at `<rootDirectory>/signing-key` (outside
 * `objects/`, so no key can name it): read when present, else 32 random
 * bytes written once with mode 0600. Never logged.
 *
 * Whole or absent, like a `put`: the key is written to a temp file and
 * fsynced, then hard-linked into place (which, unlike a rename, never
 * replaces a key already there, so the first of two racing boots wins) and
 * the folder fsynced. A power cut never leaves a short key behind.
 */
export async function loadOrCreateDiskSigningKey(
  rootDirectory: string,
): Promise<Uint8Array> {
  const path = join(rootDirectory, SIGNING_KEY_FILE);
  await mkdir(rootDirectory, { recursive: true });
  const temp = `${path}${TEMP_MARKER}${randomBytes(6).toString("hex")}`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(randomBytes(SIGNING_KEY_BYTES));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await linkUnlessPresent(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
  await fsyncFolder(rootDirectory);
  const key = await readFile(path);
  if (key.byteLength !== SIGNING_KEY_BYTES) {
    throw new Error(
      `${path}: the site files signing-key must be ${SIGNING_KEY_BYTES.toString()} bytes`,
    );
  }
  return new Uint8Array(key);
}

/** Links `temp` in at `path`; an existing `path` (another boot's key) is kept. */
async function linkUnlessPresent(temp: string, path: string): Promise<void> {
  try {
    await link(temp, path);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
}

function isSidecar(value: unknown): value is Sidecar {
  return (
    typeof value === "object" &&
    value !== null &&
    "contentType" in value &&
    typeof value.contentType === "string" &&
    "sha256" in value &&
    typeof value.sha256 === "string"
  );
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
