/**
 * What the working tree holds right now, as content hashes, for the verify
 * cache to key steps on.
 *
 * The tracked and untracked files go through a throwaway copy of the index:
 * `git add -A` into it and `git write-tree` give one tree hash for the whole
 * checkout, uncommitted edits and new files included, without touching the
 * real index. `git ls-tree` over that tree then gives every directory's and
 * file's hash, which is how a step is keyed on one package and not the rest.
 *
 * Gitignored files are inputs too: a check that walks the disk reads a
 * private pattern file or a `docs/private/` note the tree never sees. So every
 * ignored path is hashed as well, except the outputs a step derives from the
 * tree (`node_modules`, `dist`, `.dads`, `target`, `coverage`,
 * `*.tsbuildinfo`). An ignored directory too large to hash leaves the ignored
 * inputs unknown, and an unknown input means nothing keyed on it is skipped.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const DERIVED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  ".dads",
  "target",
  "coverage",
]);
const IGNORED_FILE_LIMIT = 5000;

/**
 * Git exports `GIT_DIR` and friends into the hooks it runs, and verify runs
 * from the pre-push hook. A `git` that inherits them reads the hook's
 * repository instead of `root`, so every `GIT_` variable is dropped.
 */
export function gitEnvironment(extra = {}) {
  const kept = Object.entries(process.env).filter(
    ([name]) => !name.startsWith("GIT_"),
  );
  return { ...Object.fromEntries(kept), ...extra };
}

export function git(root, args, extra = {}) {
  const run = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: gitEnvironment({ GIT_NO_REPLACE_OBJECTS: "1", ...extra }),
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0) {
    throw new Error(
      `git ${args[0]} exited ${String(run.status)}: ${run.stderr}`,
    );
  }
  return run.stdout;
}

/** History inputs used by the source ratchet, including Git's ancestry overlays. */
export function captureHistory(root, revision = "HEAD") {
  const args = ["rev-parse", "--revs-only", "--end-of-options"];
  const commit = git(root, [...args, `${revision}^{commit}`]).trim() || null;
  // Keep the order in sync with the Doctor migration baseline fallback.
  const base =
    git(root, [...args, "origin/main^{commit}", "main^{commit}"])
      .trim()
      .split("\n")[0] || null;
  return {
    commit,
    base,
    shallow: hashGitPath(root, "shallow"),
    grafts: hashGitPath(root, "info/grafts"),
  };
}

function hashGitPath(root, name) {
  const path = resolve(
    root,
    git(root, ["rev-parse", "--git-path", name]).trimEnd(),
  );
  try {
    return hashFile(path);
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    throw error;
  }
}

export function sameHistory(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The tree hash of the checkout as it is on disk, via a throwaway index. */
function writeWorkingTree(root) {
  const scratch = mkdtempSync(join(tmpdir(), "dads-verify-index-"));
  const index = join(scratch, "index");
  try {
    const realIndex = resolve(
      root,
      git(root, ["rev-parse", "--git-path", "index"]).trim(),
    );
    if (existsSync(realIndex)) copyFileSync(realIndex, index);
    const environment = { GIT_INDEX_FILE: index };
    git(root, ["add", "-A", "--", "."], environment);
    return git(root, ["write-tree"], environment).trim();
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

/** Every path in the tree, directories included, mapped to `type:hash`. */
function listTreeEntries(root, tree) {
  const entries = {};
  for (const line of git(root, ["ls-tree", "-r", "-t", "-z", tree]).split(
    "\0",
  )) {
    if (line === "") continue;
    const tab = line.indexOf("\t");
    const [, type, oid] = line.slice(0, tab).split(" ");
    entries[line.slice(tab + 1)] = `${type}:${oid}`;
  }
  return entries;
}

function isDerived(path) {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  if (trimmed.endsWith(".tsbuildinfo")) return true;
  return trimmed.split("/").some((segment) => DERIVED_SEGMENTS.has(segment));
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Every file under an ignored directory, or null past the size limit. */
function filesUnder(root, directory, found) {
  for (const entry of readdirSync(join(root, directory), {
    withFileTypes: true,
  })) {
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory()) filesUnder(root, `${path}/`, found);
    else found.push(path);
    if (found.length > IGNORED_FILE_LIMIT) return null;
  }
  return found;
}

function hashIgnoredEntry(root, path) {
  if (!path.endsWith("/")) return [[path, hashIgnoredPath(root, path)]];
  const files = filesUnder(root, path, []);
  if (files === null) return null;
  return files
    .filter((file) => !isDerived(file))
    .map((file) => [file, hashIgnoredPath(root, file)]);
}

function hashIgnoredPath(root, path) {
  const absolute = join(root, path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) return `link:${readlinkSync(absolute)}`;
  return hashFile(absolute);
}

/** `[path, hash]` for every ignored, non-derived file, or null if unknown. */
function hashIgnoredInputs(root) {
  const listed = git(root, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]).split("\0");
  const hashed = [];
  for (const path of listed) {
    if (path === "" || isDerived(path)) continue;
    const entries = hashIgnoredEntry(root, path);
    if (entries === null) return null;
    hashed.push(...entries);
  }
  return hashed.sort(([left], [right]) => (left < right ? -1 : 1));
}

/**
 * Which paths the real index tracks. The tree already holds their content,
 * but a check that lists files with `git ls-files` sees a newly added file
 * only once it is staged, so staging one is a change too.
 */
function hashTrackedPaths(root) {
  return createHash("sha256")
    .update(git(root, ["ls-files", "-z"]))
    .digest("hex");
}

/**
 * The fingerprint of the checkout, or `{ error }` when it cannot be taken —
 * not a repository, no `git`, an unreadable file. A caller treats an error as
 * "nothing is known", never as "nothing changed".
 */
export function captureFingerprint(root) {
  try {
    const tree = writeWorkingTree(root);
    const ignored = hashIgnoredInputs(root);
    if (ignored === null) {
      throw new Error(
        `an ignored directory holds over ${String(IGNORED_FILE_LIMIT)} files`,
      );
    }
    return {
      tree,
      tracked: hashTrackedPaths(root),
      entries: listTreeEntries(root, tree),
      ignored,
      history: captureHistory(root),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Two fingerprints describe the same checkout. */
export function sameFingerprint(left, right) {
  if (left.error !== undefined || right.error !== undefined) return false;
  return (
    left.tree === right.tree &&
    left.tracked === right.tracked &&
    sameHistory(left.history, right.history) &&
    JSON.stringify(left.ignored) === JSON.stringify(right.ignored)
  );
}

/** A content hash of any file on disk, `"absent"` when it does not exist. */
export function hashPathOrAbsent(root, path) {
  const absolute = join(root, path);
  return existsSync(absolute) ? hashFile(absolute) : "absent";
}
