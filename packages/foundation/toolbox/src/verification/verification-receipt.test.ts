/** Proves reusable verification is bound to an isolated captured input closure and valid local evidence. */

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureVerificationSnapshot,
  capturedSnapshotMatchesProject,
  discardVerificationSnapshot,
  type ControlledVerificationInput,
  type ControlledVerificationRequest,
  verificationEnvironment,
} from "./verification-inputs.js";
import {
  createVerificationReceiptStore,
  findSuccessfulVerificationReceipt,
  publishSuccessfulVerificationReceipt,
} from "./receipt-store.js";
import {
  runCapturedVerification,
  runReusableVerificationTask,
} from "./run-verification-task.js";
import {
  deriveVerifierIdentity,
  readVerifierIdentity,
} from "./verifier-identity.js";

const temporaryProjects: string[] = [];

afterEach(() => {
  for (const projectRoot of temporaryProjects.splice(0)) {
    makeTreeWritable(projectRoot);
    rmSync(projectRoot, { force: true, recursive: true });
  }
});

describe("verification input snapshots", () => {
  it("derives verifier identity from toolbox bytes rather than manifest input", () => {
    const toolboxRoot = mkdtempSync(join(tmpdir(), "dads-verifier-identity-"));
    temporaryProjects.push(toolboxRoot);
    writeFileSync(
      join(toolboxRoot, "verifier.js"),
      "export const version = 1;\n",
    );
    const first = deriveVerifierIdentity(toolboxRoot);
    writeFileSync(
      join(toolboxRoot, "verifier.js"),
      "export const version = 2;\n",
    );

    expect(deriveVerifierIdentity(toolboxRoot)).not.toBe(first);
    expect(readVerifierIdentity()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("denies ambient filesystem reads and nondeterministic globals", () => {
    const projectRoot = createControlledProject();
    writeFileSync(join(projectRoot, "ambient.txt"), "ambient\n");
    writeFileSync(
      join(projectRoot, "tests/verify.mjs"),
      [
        'import { readFileSync } from "node:fs";',
        'readFileSync(new URL("../ambient.txt", import.meta.url), "utf8");',
        "Date.now();",
      ].join("\n"),
    );

    const result = runReusableVerificationTask(controlledRequest(projectRoot));

    expect(result.status).toBe("failed");
  });

  it.each([
    {
      name: "high-resolution process time",
      source: "process.hrtime.bigint();",
    },
    {
      name: "performance time",
      source: "performance.now();",
    },
    {
      name: "filesystem metadata",
      source:
        'const { statSync } = await import("node:fs"); statSync(new URL("../src/input.txt", import.meta.url));',
    },
  ])("denies $name as an undeclared execution input", ({ source }) => {
    const projectRoot = createControlledProject();
    writeFileSync(
      join(projectRoot, "tests/verify.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        source,
        'writeFileSync(new URL("observed.txt", `file://${process.env["DADS_VERIFICATION_OUTPUT_DIR"]}/`), "proved\\n");',
      ].join("\n"),
    );

    const result = runReusableVerificationTask(controlledRequest(projectRoot));

    expect(result.status).toBe("failed");
  });

  it("does not observe a live A to B change after capture", () => {
    const projectRoot = createControlledProject();
    const request = controlledRequest(projectRoot);
    const snapshot = captureVerificationSnapshot(request);

    writeFileSync(join(projectRoot, "src/input.txt"), "B\n");

    expect(
      readFileSync(join(snapshot.snapshotRoot, "src/input.txt"), "utf8"),
    ).toBe("A\n");
    expect(statSync(join(snapshot.snapshotRoot, "src/input.txt")).ino).not.toBe(
      statSync(join(projectRoot, "src/input.txt")).ino,
    );
    discardVerificationSnapshot(snapshot);
  });

  it("rejects live tasks, path escapes and symlink inputs", () => {
    const projectRoot = createControlledProject();
    const baseRequest = controlledRequest(projectRoot);

    expect(() =>
      captureVerificationSnapshot({
        ...baseRequest,
        executionClass: "live",
      }),
    ).toThrow(/live verification tasks/i);
    expect(() =>
      captureVerificationSnapshot({
        ...baseRequest,
        inputFiles: [
          ...baseRequest.inputFiles,
          { path: "../outside.txt", role: "source" },
        ],
      }),
    ).toThrow(/project-relative verification path/i);

    writeFileSync(join(projectRoot, "outside.txt"), "outside\n");
    symlinkSync("../outside.txt", join(projectRoot, "src/symlink.txt"));
    expect(() =>
      captureVerificationSnapshot({
        ...baseRequest,
        inputFiles: [
          ...baseRequest.inputFiles,
          { path: "src/symlink.txt", role: "source" },
        ],
      }),
    ).toThrow(/symlink/i);
  });

  it("copies environment values, fingerprints them, and never serializes them", () => {
    const projectRoot = createControlledProject();
    const tokenEntry = {
      name: "FIXTURE_TOKEN",
      value: "do-not-report",
      secret: false,
    };
    const request = {
      ...controlledRequest(projectRoot),
      environment: [tokenEntry],
    };
    const snapshot = captureVerificationSnapshot(request);

    tokenEntry.value = "changed-after-capture";

    expect(verificationEnvironment(snapshot)["FIXTURE_TOKEN"]).toBe(
      "do-not-report",
    );
    expect(JSON.stringify(snapshot.identity)).not.toContain("do-not-report");

    const changedSnapshot = captureVerificationSnapshot(request);
    expect(changedSnapshot.identity.environmentSha256).not.toBe(
      snapshot.identity.environmentSha256,
    );
    expect(changedSnapshot.identity.snapshotId).not.toBe(
      snapshot.identity.snapshotId,
    );

    discardVerificationSnapshot(snapshot);
    discardVerificationSnapshot(changedSnapshot);
  });

  it("rejects secret-dependent tasks and unsupported input roles", () => {
    const projectRoot = createControlledProject();
    const request = controlledRequest(projectRoot);
    const invalidInputRole: ControlledVerificationInput = {
      path: "src/input.txt",
      role: "source",
    };
    Object.defineProperty(invalidInputRole, "role", { value: "unknown-role" });

    expect(() =>
      captureVerificationSnapshot({
        ...request,
        environment: [
          { name: "FIXTURE_TOKEN", value: "credential", secret: true },
        ],
      }),
    ).toThrow(/secret-dependent verification tasks/i);
    expect(() =>
      captureVerificationSnapshot({
        ...request,
        inputFiles: [
          invalidInputRole,
          { path: "tests/verify.mjs", role: "test" },
        ],
      }),
    ).toThrow(/input role/i);
  });

  it("uses a deterministic identity and invalidates every execution input class", () => {
    const projectRoot = createControlledProject();
    const request = controlledRequest(projectRoot);
    const baseline = captureVerificationSnapshot(request);
    const reordered = captureVerificationSnapshot({
      ...request,
      inputFiles: [...request.inputFiles].reverse(),
      outputFiles: [...request.outputFiles].reverse(),
      environment: [...request.environment].reverse(),
      prerequisiteIdentities: [...request.prerequisiteIdentities].reverse(),
    });

    expect(reordered.identity.snapshotId).toBe(baseline.identity.snapshotId);

    const changedRequests: ControlledVerificationRequest[] = [
      {
        ...request,
        inputFiles: [
          { path: "src/input.txt", role: "source" },
          { path: "tests/verify.mjs", role: "test" },
        ],
      },
      { ...request, runnerVersion: "vitest-next" },
      { ...request, outputFiles: ["changed-output.txt"] },
      {
        ...request,
        environment: [
          { name: "FIXTURE_TOKEN", value: "changed", secret: false },
        ],
      },
      { ...request, prerequisiteIdentities: ["policy:sha256:changed"] },
      { ...request, timeoutMilliseconds: request.timeoutMilliseconds + 1 },
    ];

    for (const changedRequest of changedRequests) {
      const changedSnapshot = captureVerificationSnapshot(changedRequest);
      expect(changedSnapshot.identity.snapshotId).not.toBe(
        baseline.identity.snapshotId,
      );
      discardVerificationSnapshot(changedSnapshot);
    }

    writeFileSync(join(projectRoot, "src/input.txt"), "changed bytes\n");
    const changedBytes = captureVerificationSnapshot(request);
    expect(changedBytes.identity.snapshotId).not.toBe(
      baseline.identity.snapshotId,
    );

    discardVerificationSnapshot(baseline);
    discardVerificationSnapshot(reordered);
    discardVerificationSnapshot(changedBytes);
  });

  it("rejects expected-file changes and undeclared files added to a snapshot", () => {
    const projectRoot = createControlledProject();
    const changedFileSnapshot = captureVerificationSnapshot(
      controlledRequest(projectRoot),
    );
    chmodSync(join(changedFileSnapshot.snapshotRoot, "src/input.txt"), 0o644);
    writeFileSync(
      join(changedFileSnapshot.snapshotRoot, "src/input.txt"),
      "changed\n",
    );

    expect(runCapturedVerification(changedFileSnapshot).status).toBe("failed");

    const addedFileSnapshot = captureVerificationSnapshot(
      controlledRequest(projectRoot),
    );
    chmodSync(addedFileSnapshot.snapshotRoot, 0o755);
    writeFileSync(join(addedFileSnapshot.snapshotRoot, "undeclared.txt"), "x");

    expect(runCapturedVerification(addedFileSnapshot).status).toBe("failed");

    discardVerificationSnapshot(changedFileSnapshot);
    discardVerificationSnapshot(addedFileSnapshot);
  });

  it("reports whether the live project still matches the captured bytes", () => {
    const projectRoot = createControlledProject();
    const snapshot = captureVerificationSnapshot(
      controlledRequest(projectRoot),
    );

    expect(capturedSnapshotMatchesProject(snapshot)).toBe(true);
    writeFileSync(join(projectRoot, "src/input.txt"), "B\n");
    expect(capturedSnapshotMatchesProject(snapshot)).toBe(false);
    writeFileSync(join(projectRoot, "src/input.txt"), "A\n");
    expect(capturedSnapshotMatchesProject(snapshot)).toBe(true);

    discardVerificationSnapshot(snapshot);
  });
});

describe("controlled verification receipts", () => {
  it("binds an ABA execution and reused lookup to the captured snapshot", () => {
    const projectRoot = createControlledProject();
    const request = controlledRequest(projectRoot);
    const snapshotA = captureVerificationSnapshot(request);

    writeFileSync(join(projectRoot, "src/input.txt"), "B\n");
    const executionA = runCapturedVerification(snapshotA);
    writeFileSync(join(projectRoot, "src/input.txt"), "A\n");

    expect(executionA.status).toBe("succeeded");
    expect(
      readFileSync(join(snapshotA.outputRoot, "observed.txt"), "utf8"),
    ).toBe("A\n");
    const store = createVerificationReceiptStore(projectRoot);
    const receiptA = publishSuccessfulVerificationReceipt(store, executionA);
    expect(JSON.stringify(receiptA)).not.toContain("do-not-report");
    expect(receiptA.identity.environmentNames).toEqual(["FIXTURE_TOKEN"]);
    expect(
      findSuccessfulVerificationReceipt(
        store,
        request.projectId,
        request.taskId,
        snapshotA.identity.snapshotId,
      ).status,
    ).toBe("match");

    writeFileSync(join(projectRoot, "src/input.txt"), "B\n");
    const snapshotB = captureVerificationSnapshot(request);
    expect(snapshotB.identity.snapshotId).not.toBe(
      snapshotA.identity.snapshotId,
    );
    expect(
      findSuccessfulVerificationReceipt(
        store,
        request.projectId,
        request.taskId,
        snapshotB.identity.snapshotId,
      ).status,
    ).toBe("missing");

    discardVerificationSnapshot(snapshotA);
    discardVerificationSnapshot(snapshotB);
  });

  it("treats corrupt evidence and timed out executions as non-success", () => {
    const projectRoot = createControlledProject();
    const request = controlledRequest(projectRoot);
    const snapshot = captureVerificationSnapshot(request);
    const execution = runCapturedVerification(snapshot);
    const store = createVerificationReceiptStore(projectRoot);
    publishSuccessfulVerificationReceipt(store, execution);
    writeFileSync(findOnlyReceipt(store.root), '{"partial":true}\n');

    expect(
      findSuccessfulVerificationReceipt(
        store,
        request.projectId,
        request.taskId,
        snapshot.identity.snapshotId,
      ).status,
    ).toBe("invalid");

    writeFileSync(
      join(projectRoot, "tests/verify.mjs"),
      "setTimeout(() => {}, 10_000);\n",
    );
    const timeoutSnapshot = captureVerificationSnapshot({
      ...request,
      timeoutMilliseconds: 20,
    });
    const timeoutExecution = runCapturedVerification(timeoutSnapshot);
    expect(timeoutExecution.status).toBe("failed");
    expect(() =>
      publishSuccessfulVerificationReceipt(store, timeoutExecution),
    ).toThrow(/failed verification/i);

    discardVerificationSnapshot(snapshot);
    discardVerificationSnapshot(timeoutSnapshot);
  });

  it("does not publish a receipt when the reusable task fails", () => {
    const projectRoot = createControlledProject();
    writeFileSync(join(projectRoot, "tests/verify.mjs"), "process.exit(7);\n");
    const request = controlledRequest(projectRoot);

    const failedTask = runReusableVerificationTask(request);

    expect(failedTask.status).toBe("failed");
    const store = createVerificationReceiptStore(projectRoot);
    const receiptFiles = listFiles(store.root).filter((path) =>
      path.endsWith(".json"),
    );
    expect(receiptFiles).toEqual([]);
  });

  it("does not publish a receipt when a required output is missing", () => {
    const projectRoot = createControlledProject();
    writeFileSync(join(projectRoot, "tests/verify.mjs"), "process.exit(0);\n");

    const missingOutputTask = runReusableVerificationTask(
      controlledRequest(projectRoot),
    );

    expect(missingOutputTask.status).toBe("failed");
    const store = createVerificationReceiptStore(projectRoot);
    expect(
      listFiles(store.root).filter((path) => path.endsWith(".json")),
    ).toEqual([]);
  });

  it("rejects runner arguments that could address the live checkout", () => {
    const projectRoot = createControlledProject();
    const request = {
      ...controlledRequest(projectRoot),
      runnerArguments: [join(projectRoot, "src/input.txt")],
    };

    expect(() => runReusableVerificationTask(request)).toThrow(
      /runner arguments are not allowed/i,
    );
    expect(readFileSync(join(projectRoot, "src/input.txt"), "utf8")).toBe(
      "A\n",
    );
  });

  it("rejects a dishonest success state and changed outputs for one snapshot", () => {
    const projectRoot = createControlledProject();
    const request = controlledRequest(projectRoot);
    const snapshot = captureVerificationSnapshot(request);
    const execution = runCapturedVerification(snapshot);
    const store = createVerificationReceiptStore(projectRoot);

    expect(() =>
      publishSuccessfulVerificationReceipt(store, {
        ...execution,
        exitCode: 1,
      }),
    ).toThrow(/successful execution/i);

    publishSuccessfulVerificationReceipt(store, execution);
    expect(() =>
      publishSuccessfulVerificationReceipt(store, {
        ...execution,
        outputs: [
          {
            path: "observed.txt",
            sha256: "0".repeat(64),
            bytes: 0,
          },
        ],
      }),
    ).toThrow(/different outputs/i);

    discardVerificationSnapshot(snapshot);
  });

  it("rejects receipt lookup through a symlinked task directory", () => {
    const projectRoot = createControlledProject();
    const request = controlledRequest(projectRoot);
    const snapshot = captureVerificationSnapshot(request);
    const execution = runCapturedVerification(snapshot);
    const store = createVerificationReceiptStore(projectRoot);
    publishSuccessfulVerificationReceipt(store, execution);

    const receiptPath = findOnlyReceipt(store.root);
    const taskDirectory = dirname(receiptPath);
    const savedTaskDirectory = `${taskDirectory}-saved`;
    renameSync(taskDirectory, savedTaskDirectory);
    symlinkSync(savedTaskDirectory, taskDirectory, "dir");

    expect(
      findSuccessfulVerificationReceipt(
        store,
        request.projectId,
        request.taskId,
        snapshot.identity.snapshotId,
      ).status,
    ).toBe("invalid");

    discardVerificationSnapshot(snapshot);
  });

  it("rejects a valid receipt copied into another project scope", () => {
    const projectRoot = createControlledProject();
    const request = controlledRequest(projectRoot);
    const snapshot = captureVerificationSnapshot(request);
    const execution = runCapturedVerification(snapshot);
    const store = createVerificationReceiptStore(projectRoot);
    publishSuccessfulVerificationReceipt(store, execution);
    const receiptPath = findOnlyReceipt(store.root);
    const foreignTaskDirectory = join(
      store.root,
      sha256("foreign-project"),
      sha256(request.taskId),
    );
    mkdirSync(foreignTaskDirectory, { recursive: true });
    copyFileSync(
      receiptPath,
      join(foreignTaskDirectory, `${snapshot.identity.snapshotId}.json`),
    );

    expect(
      findSuccessfulVerificationReceipt(
        store,
        "foreign-project",
        request.taskId,
        snapshot.identity.snapshotId,
      ).status,
    ).toBe("invalid");

    discardVerificationSnapshot(snapshot);
  });
});

function createControlledProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), "dads-receipt-"));
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
      "const liveInputPath = process.argv[2];",
      'if (liveInputPath) writeFileSync(liveInputPath, "B\\n");',
      "",
    ].join("\n"),
  );
  return projectRoot;
}

function controlledRequest(projectRoot: string): ControlledVerificationRequest {
  return {
    executionClass: "artifact-consumer-v1",
    projectId: "receipt-fixture",
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
    environment: [
      { name: "FIXTURE_TOKEN", value: "do-not-report", secret: false },
    ],
    prerequisiteIdentities: ["policy:sha256:provider"],
    timeoutMilliseconds: 2_000,
  };
}

function findOnlyReceipt(root: string): string {
  const receiptFiles = listFiles(root).filter((path) => path.endsWith(".json"));
  const receiptPath = receiptFiles[0];
  if (!receiptPath || receiptFiles.length !== 1) {
    throw new Error("Expected exactly one verification receipt.");
  }
  return receiptPath;
}

function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile() && !lstatSync(path).isSymbolicLink())
      files.push(path);
  }
  return files;
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
  for (const entry of readdirSync(path)) {
    makeTreeWritable(join(path, entry));
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
