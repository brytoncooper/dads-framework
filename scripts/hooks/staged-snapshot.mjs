import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";

const gitOutputLimit = 128 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function git(root, args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    maxBuffer: gitOutputLimit,
    ...options,
  });
}

function nulRecords(bytes) {
  return utf8.decode(bytes).split("\0").slice(0, -1);
}

export function changedIndexPaths(root) {
  return new Set(
    nulRecords(
      git(root, [
        "diff",
        "--cached",
        "--name-only",
        "--no-renames",
        "--diff-filter=AMT",
        "-z",
      ]),
    ),
  );
}

export function treeEntries(root, tree) {
  return nulRecords(git(root, ["ls-tree", "-r", "-z", tree])).map((entry) => {
    const separator = entry.indexOf("\t");
    const [mode, kind, oid] = entry.slice(0, separator).split(" ");
    return { mode, kind, oid, path: entry.slice(separator + 1) };
  });
}

export function isRegular({ mode }) {
  return mode === "100644" || mode === "100755";
}

function indexedBlobOffsets(root, spool, entries) {
  const requested = [...new Set(entries.map(({ oid }) => oid))];
  git(root, ["cat-file", "--batch"], {
    input: requested.map((oid) => oid + "\n").join(""),
    stdio: ["pipe", spool, "inherit"],
  });
  const offsets = new Map();
  const header = Buffer.alloc(128);
  let cursor = 0;
  for (const oid of requested) {
    const read = readSync(spool, header, 0, header.length, cursor);
    const end = header.subarray(0, read).indexOf(10);
    const [actualOid, type, length] = header
      .toString("ascii", 0, end)
      .split(" ");
    const size = Number(length);
    if (
      end < 0 ||
      actualOid !== oid ||
      type !== "blob" ||
      !Number.isSafeInteger(size)
    ) {
      throw new Error(`Cannot read staged blob ${oid}.`);
    }
    const position = cursor + end + 1;
    offsets.set(oid, { position, size });
    cursor = position + size + 1;
  }
  return offsets;
}

function readBlob(spool, { position, size }) {
  const bytes = Buffer.allocUnsafe(size);
  const read = readSync(spool, bytes, 0, size, position);
  if (read !== size) throw new Error("The staged blob was truncated.");
  return bytes;
}

function writeSnapshotEntries(root, entries, spool, destination, changedPaths) {
  const offsets = indexedBlobOffsets(root, spool, entries);
  const changed = new Map();
  for (const entry of entries) {
    const bytes = readBlob(spool, offsets.get(entry.oid));
    const file = join(destination, entry.path);
    mkdirSync(dirname(file), { recursive: true });
    if (isRegular(entry)) {
      writeFileSync(file, bytes, {
        mode: Number.parseInt(entry.mode, 8) & 0o777,
      });
      if (changedPaths.has(entry.path)) {
        changed.set(entry.path, { ...entry, bytes });
      }
    } else if (entry.mode === "120000") {
      symlinkSync(bytes, file);
    } else {
      throw new Error(`Cannot materialize staged mode ${entry.mode}.`);
    }
  }
  return changed;
}

export function writeSnapshot(root, tree, destination, changedPaths) {
  const entries = treeEntries(root, tree).filter(({ kind }) => kind === "blob");
  const spool = openSync(
    join(dirname(destination), "index-blobs"),
    "w+",
    0o600,
  );
  try {
    return writeSnapshotEntries(
      root,
      entries,
      spool,
      destination,
      changedPaths,
    );
  } finally {
    closeSync(spool);
  }
}
