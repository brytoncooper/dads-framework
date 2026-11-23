/** Proves a receipt is written under an exclusive task lock and only ever appears complete. */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVerificationReceiptStore, publishSuccessfulVerificationReceipt } from "./receipt-store.js";
import { runCapturedVerification } from "./run-verification-task.js";
import {
  captureVerificationSnapshot,
  discardVerificationSnapshot,
  type ControlledVerificationRequest,
} from "./verification-inputs.js";
import type { ControlledVerificationExecution } from "./verification-receipt.js";

const temporaryProjects: string[] = [];

afterEach(() => {
  for (const projectRoot of temporaryProjects.splice(0)) {
    makeTreeWritable(projectRoot);
    rmSync(projectRoot, { force: true, recursive: true });
  }
});

describe("verification receipt writes", () => {
  it("refuses to publish while another run owns the task lock", () => {
    const projectRoot = createControlledProject();
    const request = controlledRequest(projectRoot);
    const execution = succeededExecution(request);
    const store = createVerificationReceiptStore(projectRoot);
    const lockDirectory = `${taskDirectoryOf(store.root, request)}.lock`;
    mkdirSync(lockDirectory, { recursive: true });

    expect(() => publishSuccessfulVerificationReceipt(store, execution)).toThrow(
      /verification receipt task is already owned/i,
    );
    expect(existsSync(lockDirectory)).toBe(true);
    expect(receiptFileNames(taskDirectoryOf(store.root, request))).toEqual([]);
  });

  it("releases the task lock and leaves only the finished receipt behind", () => {
    const projectRoot = createControlledProject();
    const request = controlledRequest(projectRoot);
    const execution = succeededExecution(request);
    const store = createVerificationReceiptStore(projectRoot);

    const receipt = publishSuccessfulVerificationReceipt(store, execution);

    const taskDirectory = taskDirectoryOf(store.root, request);
    expect(receiptFileNames(taskDirectory)).toEqual([`${receipt.snapshotId}.json`]);
    expect(existsSync(`${taskDirectory}.lock`)).toBe(false);
    expect(statSync(join(taskDirectory, `${receipt.snapshotId}.json`)).mode & 0o777).toBe(0o600);
  });

  it("leaves no partial receipt behind when a republish is refused", () => {
    const projectRoot = createControlledProject();
    const request = controlledRequest(projectRoot);
    const execution = succeededExecution(request);
    const store = createVerificationReceiptStore(projectRoot);
    const receipt = publishSuccessfulVerificationReceipt(store, execution);

    expect(() =>
      publishSuccessfulVerificationReceipt(store, {
        ...execution,
        outputs: [{ path: "observed.txt", sha256: "0".repeat(64), bytes: 0 }],
      }),
    ).toThrow(/different outputs/i);

    const taskDirectory = taskDirectoryOf(store.root, request);
    expect(readdirSync(taskDirectory)).toEqual([`${receipt.snapshotId}.json`]);
    expect(existsSync(`${taskDirectory}.lock`)).toBe(false);
  });
});

function succeededExecution(request: ControlledVerificationRequest): ControlledVerificationExecution {
  const snapshot = captureVerificationSnapshot(request);
  try {
    const execution = runCapturedVerification(snapshot);
    if (execution.status !== "succeeded") {
      throw new Error(`Expected a successful fixture run: ${execution.status}.`);
    }
    return execution;
  } finally {
    discardVerificationSnapshot(snapshot);
  }
}

function taskDirectoryOf(receiptRoot: string, request: ControlledVerificationRequest): string {
  return join(receiptRoot, sha256(request.projectId), sha256(request.taskId));
}

function receiptFileNames(taskDirectory: string): readonly string[] {
  if (!existsSync(taskDirectory)) return [];
  return readdirSync(taskDirectory).filter((name) => name.endsWith(".json"));
}

function createControlledProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), "dads-receipt-writes-"));
  temporaryProjects.push(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  mkdirSync(join(projectRoot, "tests"), { recursive: true });
  writeFileSync(join(projectRoot, "src/input.txt"), "A\n");
  writeFileSync(
    join(projectRoot, "tests/verify.mjs"),
    [
      'import { readFileSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'const input = readFileSync(join(process.cwd(), "src/input.txt"), "utf8");',
      'writeFileSync(join(process.env["DADS_VERIFICATION_OUTPUT_DIR"], "observed.txt"), input);',
      "",
    ].join("\n"),
  );
  return projectRoot;
}

function controlledRequest(projectRoot: string): ControlledVerificationRequest {
  return {
    executionClass: "artifact-consumer-v1",
    projectId: "receipt-write-fixture",
    taskId: "artifact-consumer:test",
    projectRoot,
    workingDirectory: ".",
    runnerEntrypoint: "tests/verify.mjs",
    runnerArguments: [],
    runnerVersion: "vitest-4.1.11",
    inputFiles: [
      { path: "src/input.txt", role: "artifact" },
      { path: "tests/verify.mjs", role: "test" },
    ],
    outputFiles: ["observed.txt"],
    environment: [],
    prerequisiteIdentities: ["policy:sha256:provider"],
    timeoutMilliseconds: 5_000,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeTreeWritable(path: string): void {
  if (!existsSync(path)) return;
  const status = lstatSync(path);
  if (status.isSymbolicLink()) return;
  if (status.isFile()) {
    chmodSync(path, 0o644);
    return;
  }
  if (!status.isDirectory()) return;
  chmodSync(path, 0o755);
  for (const entry of readdirSync(path)) makeTreeWritable(join(path, entry));
}
