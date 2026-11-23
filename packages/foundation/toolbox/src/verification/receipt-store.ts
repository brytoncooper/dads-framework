import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  createSuccessfulVerificationReceipt,
  parseSuccessfulVerificationReceipt,
  type ControlledVerificationExecution,
  type SuccessfulVerificationReceipt,
} from "./verification-receipt.js";

export type VerificationReceiptStore = {
  readonly root: string;
};

export type VerificationReceiptLookup =
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly reason: string }
  | {
      readonly status: "match";
      readonly receipt: SuccessfulVerificationReceipt;
    };

export function createVerificationReceiptStore(projectRoot: string): VerificationReceiptStore {
  const canonicalProjectRoot = realpathSync(projectRoot);
  const dadsRoot = ensureReceiptDirectory(canonicalProjectRoot, ".dads");
  const verificationRoot = ensureReceiptDirectory(dadsRoot, "verification");
  return { root: ensureReceiptDirectory(verificationRoot, "receipts") };
}

export function publishSuccessfulVerificationReceipt(
  store: VerificationReceiptStore,
  execution: ControlledVerificationExecution,
): SuccessfulVerificationReceipt {
  assertRealDirectory(store.root);
  const receipt = createSuccessfulVerificationReceipt(execution);
  const taskDirectory = ensureReceiptTaskDirectory(store, receipt.projectId, receipt.taskId);
  const lockDirectory = `${taskDirectory}.lock`;
  acquireTaskLock(lockDirectory);
  const receiptPath = join(taskDirectory, `${receipt.snapshotId}.json`);
  const temporaryPath = join(taskDirectory, `.partial-${randomUUID()}`);
  try {
    const existingReceipt = readExistingReceipt(receiptPath, receipt);
    if (existingReceipt) return existingReceipt;
    writeAtomicFile(temporaryPath, receiptPath, `${JSON.stringify(receipt)}\n`);
    return receipt;
  } finally {
    rmSync(temporaryPath, { force: true });
    rmSync(lockDirectory, { force: true, recursive: true });
  }
}

export function findSuccessfulVerificationReceipt(
  store: VerificationReceiptStore,
  projectId: string,
  taskId: string,
  snapshotId: string,
): VerificationReceiptLookup {
  try {
    if (!/^[a-f0-9]{64}$/.test(snapshotId)) {
      return {
        status: "invalid",
        reason: "Snapshot identity is not a SHA-256 hash.",
      };
    }
    assertRealDirectory(store.root);
    const taskDirectory = findReceiptTaskDirectory(store, projectId, taskId);
    if (!taskDirectory) return { status: "missing" };
    const receiptPath = join(taskDirectory, `${snapshotId}.json`);
    if (!existsSync(receiptPath)) return { status: "missing" };
    assertRegularReceiptFile(receiptPath);
    const receipt = parseSuccessfulVerificationReceipt(JSON.parse(readFileSync(receiptPath, "utf8")));
    if (receipt.projectId !== projectId || receipt.taskId !== taskId || receipt.snapshotId !== snapshotId) {
      return {
        status: "invalid",
        reason: "Receipt does not belong to the requested project, task, and snapshot.",
      };
    }
    return { status: "match", receipt };
  } catch (error: unknown) {
    return {
      status: "invalid",
      reason: error instanceof Error ? error.message : "Invalid receipt.",
    };
  }
}

function ensureReceiptTaskDirectory(store: VerificationReceiptStore, projectId: string, taskId: string): string {
  const projectDirectory = ensureReceiptDirectory(store.root, scopedHash(projectId));
  return ensureReceiptDirectory(projectDirectory, scopedHash(taskId));
}

function acquireTaskLock(lockDirectory: string): void {
  try {
    mkdirSync(lockDirectory);
  } catch (error: unknown) {
    throw new Error(`Verification receipt task is already owned: ${lockErrorMessage(error)}`, { cause: error });
  }
}

function readExistingReceipt(
  receiptPath: string,
  expectedReceipt: SuccessfulVerificationReceipt,
): SuccessfulVerificationReceipt | undefined {
  if (!existsSync(receiptPath)) return undefined;
  assertRegularReceiptFile(receiptPath);
  const existingReceipt = parseSuccessfulVerificationReceipt(JSON.parse(readFileSync(receiptPath, "utf8")));
  if (
    existingReceipt.projectId !== expectedReceipt.projectId ||
    existingReceipt.taskId !== expectedReceipt.taskId ||
    existingReceipt.snapshotId !== expectedReceipt.snapshotId
  ) {
    throw new Error("Existing verification receipt has the wrong identity.");
  }
  if (JSON.stringify(existingReceipt.identity) !== JSON.stringify(expectedReceipt.identity)) {
    throw new Error("Existing verification receipt has different inputs.");
  }
  if (JSON.stringify(existingReceipt.outputs) !== JSON.stringify(expectedReceipt.outputs)) {
    throw new Error("Existing verification receipt has different outputs.");
  }
  return existingReceipt;
}

function writeAtomicFile(temporaryPath: string, receiptPath: string, contents: string): void {
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, receiptPath);
  fsyncDirectory(dirname(receiptPath));
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertRegularReceiptFile(receiptPath: string): void {
  const status = lstatSync(receiptPath);
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1) {
    throw new Error("Verification receipt is not a private regular file.");
  }
}

/** Creates a receipt directory, refusing a fake one; `snapshot-capture.ts` has `ensureWorkDirectory`. */
function ensureReceiptDirectory(parent: string, name: string): string {
  const directory = join(parent, name);
  if (!existsSync(directory)) mkdirSync(directory);
  const status = lstatSync(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error("Verification receipt path is not a real directory.");
  }
  return directory;
}

function findReceiptTaskDirectory(
  store: VerificationReceiptStore,
  projectId: string,
  taskId: string,
): string | undefined {
  const projectDirectory = join(store.root, scopedHash(projectId));
  if (!existsSync(projectDirectory)) return undefined;
  assertRealDirectory(projectDirectory);
  const taskDirectory = join(projectDirectory, scopedHash(taskId));
  if (!existsSync(taskDirectory)) return undefined;
  assertRealDirectory(taskDirectory);
  return taskDirectory;
}

function assertRealDirectory(directory: string): void {
  const status = lstatSync(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error("Verification receipt path is not a real directory.");
  }
}

/** Mints a receipt scope directory name, refusing a blank scope; `execute-graph-task.ts` has `receiptPathSegment`. */
function scopedHash(value: string): string {
  if (value.trim().length === 0) throw new Error("Receipt scope must be non-empty.");
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Why taking the receipt lock failed. The fallback names the lock rather than
 * the verification, which is what separates it from `errorMessage` in
 * `verification-failure.ts`.
 */
function lockErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown lock failure.";
}
