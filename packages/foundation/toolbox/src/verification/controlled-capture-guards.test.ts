/** Proves a controlled capture request is refused for every shape the snapshot could not stand behind. */

import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSnapshotMatchesIdentity,
  captureVerificationSnapshot,
  discardVerificationSnapshot,
  type ControlledVerificationRequest,
} from "./verification-inputs.js";

const temporaryProjects: string[] = [];

afterEach(() => {
  for (const projectRoot of temporaryProjects.splice(0)) {
    makeTreeWritable(projectRoot);
    rmSync(projectRoot, { force: true, recursive: true });
  }
});

describe("controlled capture request guards", () => {
  it("refuses a working directory other than the snapshot root", () => {
    const request = controlledRequest(createControlledProject());

    expect(() =>
      captureVerificationSnapshot({
        ...request,
        workingDirectory: "packages/consumer",
      }),
    ).toThrow("Controlled verification must run from the snapshot root.");
  });

  it("refuses an entrypoint that is not a declared input", () => {
    const request = controlledRequest(createControlledProject());

    expect(() =>
      captureVerificationSnapshot({
        ...request,
        inputFiles: [{ path: "src/input.txt", role: "artifact" }],
      }),
    ).toThrow("The controlled runner entrypoint must be a declared input.");
  });

  it("refuses a request that declares no required outputs", () => {
    const request = controlledRequest(createControlledProject());

    expect(() => captureVerificationSnapshot({ ...request, outputFiles: [] })).toThrow(
      "Controlled verification must declare required outputs.",
    );
  });

  it.each(["DADS_VERIFICATION_OUTPUT_DIR", "DADS_VERIFICATION_SNAPSHOT_ROOT", "NODE_OPTIONS", "LANG", "TZ"])(
    "refuses the reserved environment name %s",
    (name) => {
      const request = controlledRequest(createControlledProject());

      expect(() =>
        captureVerificationSnapshot({
          ...request,
          environment: [{ name, value: "hijacked", secret: false }],
        }),
      ).toThrow(`Verification environment ${name} is reserved.`);
    },
  );

  it("refuses an environment name outside the upper-case pattern", () => {
    const request = controlledRequest(createControlledProject());

    expect(() =>
      captureVerificationSnapshot({
        ...request,
        environment: [{ name: "fixture_token", value: "value", secret: false }],
      }),
    ).toThrow("Invalid verification environment name fixture_token.");
  });

  it("refuses a duplicate environment name", () => {
    const request = controlledRequest(createControlledProject());

    expect(() =>
      captureVerificationSnapshot({
        ...request,
        environment: [
          { name: "FIXTURE_TOKEN", value: "first", secret: false },
          { name: "FIXTURE_TOKEN", value: "second", secret: false },
        ],
      }),
    ).toThrow("Duplicate verification environment name.");
  });

  it("refuses a duplicate prerequisite identity", () => {
    const request = controlledRequest(createControlledProject());

    expect(() =>
      captureVerificationSnapshot({
        ...request,
        prerequisiteIdentities: ["policy:sha256:provider", "policy:sha256:provider"],
      }),
    ).toThrow("Duplicate verification prerequisite identity.");
  });

  it("refuses two spellings of the same input path", () => {
    const request = controlledRequest(createControlledProject());

    expect(() =>
      captureVerificationSnapshot({
        ...request,
        inputFiles: [...request.inputFiles, { path: "./src/input.txt", role: "artifact" }],
      }),
    ).toThrow("Duplicate verification input path.");
  });

  it("refuses two spellings of the same output path", () => {
    const request = controlledRequest(createControlledProject());

    expect(() =>
      captureVerificationSnapshot({
        ...request,
        outputFiles: ["observed.txt", "./observed.txt"],
      }),
    ).toThrow("Duplicate verification output path.");
  });

  it("refuses an input that reaches into Dads local state", () => {
    const projectRoot = createControlledProject();
    mkdirSync(join(projectRoot, ".dads"), { recursive: true });
    writeFileSync(join(projectRoot, ".dads/state.json"), "{}\n");
    const request = controlledRequest(projectRoot);

    expect(() =>
      captureVerificationSnapshot({
        ...request,
        inputFiles: [...request.inputFiles, { path: ".dads/state.json", role: "configuration" }],
      }),
    ).toThrow("Verification inputs cannot include Dads local state.");
  });

  it("refuses a captured input that shares storage with another file", () => {
    const projectRoot = createControlledProject();
    const snapshot = captureVerificationSnapshot(controlledRequest(projectRoot));
    const capturedPath = join(snapshot.snapshotRoot, "src/input.txt");
    chmodSync(snapshot.snapshotRoot, 0o755);
    chmodSync(join(snapshot.snapshotRoot, "src"), 0o755);
    rmSync(capturedPath);
    linkSync(join(projectRoot, "src/input.txt"), capturedPath);

    expect(() => {
      assertSnapshotMatchesIdentity(snapshot.snapshotRoot, snapshot.identity);
    }).toThrow("Captured verification input is unsafe: src/input.txt.");

    discardVerificationSnapshot(snapshot);
  });
});

function createControlledProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), "dads-capture-guards-"));
  temporaryProjects.push(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  mkdirSync(join(projectRoot, "tests"), { recursive: true });
  writeFileSync(join(projectRoot, "src/input.txt"), "A\n");
  writeFileSync(join(projectRoot, "tests/verify.mjs"), 'import { readFileSync, writeFileSync } from "node:fs";\n');
  return projectRoot;
}

function controlledRequest(projectRoot: string): ControlledVerificationRequest {
  return {
    executionClass: "artifact-consumer-v1",
    projectId: "capture-guard-fixture",
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
    environment: [{ name: "FIXTURE_TOKEN", value: "do-not-report", secret: false }],
    prerequisiteIdentities: ["policy:sha256:provider"],
    timeoutMilliseconds: 2_000,
  };
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
