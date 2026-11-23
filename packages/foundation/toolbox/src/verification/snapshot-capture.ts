/**
 * The captured verification tree: the copy of the declared inputs that a
 * controlled task actually runs against.
 *
 * Everything here is about bytes on disk — where the copy lives, how each file
 * is read without racing the live checkout, what the copy is allowed to
 * contain, and how it is fingerprinted, frozen, and removed. What those
 * fingerprints then mean is the identity's business, not this module's.
 */
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  type BigIntStats,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { canonicalJson, compareText, sha256 } from "./canonical-bytes.js";
import { assertNoSymlinkComponents, normalizeRelativePath, resolveInside } from "./filesystem-guards.js";

export type VerificationInputRole = "source" | "test" | "configuration" | "resolved-dependency" | "artifact";

export type ControlledVerificationInput = {
  readonly path: string;
  readonly role: VerificationInputRole;
};

export type VerificationInputFingerprint = {
  readonly path: string;
  readonly role: VerificationInputRole;
  readonly sha256: string;
  readonly bytes: number;
};

/** Where captured trees and their outputs live inside a project's local state. */
export type VerificationWorkRoot = {
  readonly snapshots: string;
  readonly outputs: string;
};

export function ensureVerificationWorkRoot(projectRoot: string): VerificationWorkRoot {
  const dadsRoot = ensureWorkDirectory(projectRoot, ".dads");
  const verificationRoot = ensureWorkDirectory(dadsRoot, "verification");
  return {
    snapshots: ensureWorkDirectory(verificationRoot, "snapshots"),
    outputs: ensureWorkDirectory(verificationRoot, "outputs"),
  };
}

/** Copies each declared input into the snapshot, read-only and unshared, in path order. */
export function copyVerificationInputs(
  projectRoot: string,
  snapshotRoot: string,
  inputs: readonly ControlledVerificationInput[],
): readonly VerificationInputFingerprint[] {
  return [...inputs]
    .map((input) => ({
      path: normalizeRelativePath(input.path),
      role: input.role,
    }))
    .sort((firstInput, secondInput) => compareText(firstInput.path, secondInput.path))
    .map((input) => {
      const destination = resolve(snapshotRoot, input.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, readStableProjectFile(projectRoot, input.path), {
        flag: "wx",
        mode: 0o444,
      });
      chmodSync(destination, 0o444);
      return fingerprintSnapshotFile(snapshotRoot, input.path, input.role);
    });
}

/** Refuses a captured tree that has gained, lost, or altered a single byte. */
export function assertCapturedFilesUnchanged(
  snapshotRoot: string,
  declaredFiles: readonly VerificationInputFingerprint[],
): void {
  assertCapturedTreeUnchanged(snapshotRoot, declaredFiles);
  const currentFiles = declaredFiles.map((file) => fingerprintSnapshotFile(snapshotRoot, file.path, file.role));
  if (canonicalJson(currentFiles) !== canonicalJson(declaredFiles)) {
    throw new Error("Captured verification inputs changed after snapshotting.");
  }
}

/** Whether the live project still holds exactly the bytes that were captured. */
export function projectFilesMatchCapture(
  projectRoot: string,
  capturedFiles: readonly VerificationInputFingerprint[],
): boolean {
  try {
    const projectFiles = capturedFiles.map((file) => fingerprintProjectFile(projectRoot, file.path, file.role));
    return canonicalJson(projectFiles) === canonicalJson(capturedFiles);
  } catch {
    return false;
  }
}

export function makeSnapshotReadOnly(snapshotRoot: string): void {
  const directories = listDirectories(snapshotRoot).sort(
    (firstDirectory, secondDirectory) => secondDirectory.length - firstDirectory.length,
  );
  for (const directory of directories) chmodSync(directory, 0o555);
  chmodSync(snapshotRoot, 0o555);
}

export function removeCapturedTree(snapshotRoot: string): void {
  if (!existsSync(snapshotRoot)) return;
  chmodTreeWritable(snapshotRoot);
  rmSync(snapshotRoot, { force: true, recursive: true });
}

/**
 * Reads a project file through one descriptor and proves the same inode, size
 * and timestamps before and after, so a file swapped mid-read is a failure
 * rather than a silent capture of two different files.
 */
function readStableProjectFile(projectRoot: string, projectPath: string): Buffer {
  const absolutePath = resolveProjectFile(projectRoot, projectPath);
  const pathStatusBeforeRead = lstatSync(absolutePath, { bigint: true });
  const descriptor = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const descriptorStatusBeforeRead = fstatSync(descriptor, { bigint: true });
    assertStableFileStatus(pathStatusBeforeRead, descriptorStatusBeforeRead, projectPath);
    const contents = readFileSync(descriptor);
    const descriptorStatusAfterRead = fstatSync(descriptor, { bigint: true });
    const pathStatusAfterRead = lstatSync(absolutePath, { bigint: true });
    assertStableFileStatus(descriptorStatusBeforeRead, descriptorStatusAfterRead, projectPath);
    assertStableFileStatus(descriptorStatusAfterRead, pathStatusAfterRead, projectPath);
    return contents;
  } finally {
    closeSync(descriptor);
  }
}

function assertStableFileStatus(before: BigIntStats, after: BigIntStats, projectPath: string): void {
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error(`Verification input changed while captured: ${projectPath}.`);
  }
}

function fingerprintProjectFile(
  projectRoot: string,
  projectPath: string,
  role: VerificationInputRole,
): VerificationInputFingerprint {
  const contents = readStableProjectFile(projectRoot, projectPath);
  return {
    path: projectPath,
    role,
    sha256: sha256(contents),
    bytes: contents.byteLength,
  };
}

function fingerprintSnapshotFile(
  snapshotRoot: string,
  snapshotPath: string,
  role: VerificationInputRole,
): VerificationInputFingerprint {
  const contents = readFileSync(resolveSnapshotFile(snapshotRoot, snapshotPath));
  return {
    path: snapshotPath,
    role,
    sha256: sha256(contents),
    bytes: contents.byteLength,
  };
}

function assertCapturedTreeUnchanged(
  snapshotRoot: string,
  declaredFiles: readonly VerificationInputFingerprint[],
): void {
  const actualEntries = listCapturedTreeEntries(snapshotRoot);
  const expectedFiles = declaredFiles.map((file) => file.path).sort(compareText);
  const expectedDirectories = directoriesContainingFiles(expectedFiles);
  if (
    canonicalJson(actualEntries.files) !== canonicalJson(expectedFiles) ||
    canonicalJson(actualEntries.directories) !== canonicalJson(expectedDirectories)
  ) {
    throw new Error("Captured verification tree contains undeclared inputs.");
  }
}

function listCapturedTreeEntries(
  root: string,
  directory = root,
): {
  readonly files: readonly string[];
  readonly directories: readonly string[];
} {
  const files: string[] = [];
  const directories: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    const snapshotPath = relative(root, absolutePath).split(sep).join("/");
    if (entry.isSymbolicLink()) {
      throw new Error(`Captured verification tree contains a symlink: ${snapshotPath}.`);
    }
    if (entry.isDirectory()) {
      directories.push(snapshotPath);
      const nestedEntries = listCapturedTreeEntries(root, absolutePath);
      files.push(...nestedEntries.files);
      directories.push(...nestedEntries.directories);
    } else if (entry.isFile()) {
      files.push(snapshotPath);
    } else {
      throw new Error(`Captured verification tree contains an unsupported input: ${snapshotPath}.`);
    }
  }
  return {
    files: files.sort(compareText),
    directories: directories.sort(compareText),
  };
}

function directoriesContainingFiles(files: readonly string[]): readonly string[] {
  const directories = new Set<string>();
  for (const file of files) {
    let directory = posix.dirname(file);
    while (directory !== ".") {
      directories.add(directory);
      directory = posix.dirname(directory);
    }
  }
  return [...directories].sort(compareText);
}

/** Creates a verification work directory, refusing a fake one; `receipt-store.ts` has `ensureReceiptDirectory`. */
function ensureWorkDirectory(parent: string, name: string): string {
  const directory = join(parent, name);
  if (!existsSync(directory)) mkdirSync(directory);
  const status = lstatSync(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`Verification work path is not a real directory: ${directory}.`);
  }
  return directory;
}

function resolveProjectFile(projectRoot: string, projectPath: string): string {
  if (projectPath === ".dads" || projectPath.startsWith(".dads/")) {
    throw new Error("Verification inputs cannot include Dads local state.");
  }
  const absolutePath = resolveInside(projectRoot, projectPath);
  assertNoSymlinkComponents(projectRoot, projectPath);
  const status = lstatSync(absolutePath);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`Verification input must be a regular file: ${projectPath}.`);
  }
  return absolutePath;
}

/**
 * A captured file must be the only name for its bytes. A second hard link is a
 * second way to rewrite the file after it was fingerprinted, from outside the
 * snapshot and without touching any path this module reads, so a shared inode
 * is unsafe rather than merely surprising. Every read of a captured file comes
 * through here, including the fingerprint `copyVerificationInputs` takes of the
 * copy it has just written.
 */
function resolveSnapshotFile(snapshotRoot: string, snapshotPath: string): string {
  const absolutePath = resolveInside(snapshotRoot, snapshotPath);
  assertNoSymlinkComponents(snapshotRoot, snapshotPath);
  const status = lstatSync(absolutePath);
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1) {
    throw new Error(`Captured verification input is unsafe: ${snapshotPath}.`);
  }
  return absolutePath;
}

function chmodTreeWritable(root: string): void {
  const status = lstatSync(root);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error("Refusing to remove an unsafe verification snapshot.");
  }
  chmodSync(root, 0o755);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) chmodTreeWritable(path);
    else if (entry.isFile()) chmodSync(path, 0o644);
  }
}

function listDirectories(root: string): string[] {
  const directories: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    directories.push(directory, ...listDirectories(directory));
  }
  return directories;
}
