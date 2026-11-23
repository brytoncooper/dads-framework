/** Proves a controlled runner may only import the allowlisted builtins and literal local modules. */

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureVerificationSnapshot,
  discardVerificationSnapshot,
  type ControlledVerificationInput,
  type ControlledVerificationRequest,
} from "./verification-inputs.js";
import { runCapturedVerification } from "./run-verification-task.js";

const temporaryProjects: string[] = [];

afterEach(() => {
  for (const projectRoot of temporaryProjects.splice(0)) {
    makeTreeWritable(projectRoot);
    rmSync(projectRoot, { force: true, recursive: true });
  }
});

describe("controlled import allowlist", () => {
  it("allows the allowlisted builtins and a literal relative import", () => {
    const projectRoot = createControlledProject(
      [
        'import { readFileSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'import assert from "node:assert/strict";',
        'import { message } from "./helper.mjs";',
        'assert.equal(typeof message, "string");',
        'const input = readFileSync(join(process.cwd(), "src/input.txt"), "utf8");',
        'writeFileSync(join(process.env["DADS_VERIFICATION_OUTPUT_DIR"], "observed.txt"), input);',
      ].join("\n"),
    );
    writeFileSync(join(projectRoot, "tests/helper.mjs"), 'export const message = "allowed";\n');
    const baseRequest = controlledRequest(projectRoot);
    const helper: ControlledVerificationInput = {
      path: "tests/helper.mjs",
      role: "test",
    };

    const snapshot = captureVerificationSnapshot({
      ...baseRequest,
      inputFiles: [...baseRequest.inputFiles, helper],
    });
    const execution = runCapturedVerification(snapshot);

    expect(execution.status).toBe("succeeded");
    discardVerificationSnapshot(snapshot);
  });

  it("refuses a builtin the allowlist does not name", () => {
    const projectRoot = createControlledProject('import { createHash } from "node:crypto";\ncreateHash("sha256");\n');

    expect(failureFor(projectRoot)).toBe("Controlled verification import is not allowlisted: node:crypto.");
  });

  it("refuses a package import the allowlist does not name", () => {
    const projectRoot = createControlledProject('import { describe } from "vitest";\ndescribe;\n');

    expect(failureFor(projectRoot)).toBe("Controlled verification package import is not allowlisted: vitest.");
  });

  it("refuses a dynamic import whose specifier is not a literal", () => {
    const projectRoot = createControlledProject('const specifier = "node:fs";\nawait import(specifier);\n');

    expect(failureFor(projectRoot)).toBe("Controlled verification dynamic imports must be literal.");
  });

  it("refuses a literal dynamic import of a builtin outside the allowlist", () => {
    const projectRoot = createControlledProject('await import("node:child_process");\n');

    expect(failureFor(projectRoot)).toBe("Controlled verification import is not allowlisted: node:child_process.");
  });
});

function failureFor(projectRoot: string): string | undefined {
  const snapshot = captureVerificationSnapshot(controlledRequest(projectRoot));
  try {
    return runCapturedVerification(snapshot).failure;
  } finally {
    discardVerificationSnapshot(snapshot);
  }
}

function createControlledProject(runnerSource: string): string {
  const projectRoot = mkdtempSync(join(tmpdir(), "dads-import-allowlist-"));
  temporaryProjects.push(projectRoot);
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  mkdirSync(join(projectRoot, "tests"), { recursive: true });
  writeFileSync(join(projectRoot, "src/input.txt"), "A\n");
  writeFileSync(join(projectRoot, "tests/verify.mjs"), runnerSource);
  return projectRoot;
}

function controlledRequest(projectRoot: string): ControlledVerificationRequest {
  return {
    executionClass: "artifact-consumer-v1",
    projectId: "import-allowlist-fixture",
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
