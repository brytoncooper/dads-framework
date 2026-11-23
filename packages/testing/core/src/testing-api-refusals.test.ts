import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeNativeBinary } from "./test-support/native-fixture.js";
import { planTesting, runTesting } from "./testing-api.js";

/**
 * The facade half of the wire-version invariant. `testing-api.test.ts` proves
 * what the facade reads from an envelope it accepts; every case here is an
 * envelope it must refuse, so that a caller never receives a result the engine
 * did not actually produce for the operation it asked about.
 */

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Dads Testing native facade refusals", () => {
  it("refuses a native response whose schemaVersion is not the protocol version", async () => {
    const directory = makeTemporaryDirectory();
    const { binary } = createFakeNativeBinary(directory, {
      schemaVersion: 2,
      ok: true,
      result: { operation: "plan", plan: planPayload() },
    });

    await expect(planTesting({ workspaceRoot: directory, nativeBinary: binary })).rejects.toThrow(
      "Unsupported native response schemaVersion 2.",
    );
  });

  it("refuses a non-ok envelope, reporting the engine's own error message", async () => {
    const directory = makeTemporaryDirectory();
    const { binary } = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: false,
      error: "--all cannot be combined with --base or --head.",
    });

    await expect(planTesting({ workspaceRoot: directory, nativeBinary: binary })).rejects.toThrow(
      "--all cannot be combined with --base or --head.",
    );
  });

  it("refuses an ok envelope that carries no result at all", async () => {
    const directory = makeTemporaryDirectory();
    const { binary } = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
    });

    await expect(planTesting({ workspaceRoot: directory, nativeBinary: binary })).rejects.toThrow(
      "The native testing engine failed without an error message.",
    );
  });

  it("refuses a result for an operation the caller did not request", async () => {
    const directory = makeTemporaryDirectory();
    const { binary } = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "run", plan: planPayload() },
    });

    await expect(planTesting({ workspaceRoot: directory, nativeBinary: binary })).rejects.toThrow(
      "The native testing engine returned run for plan.",
    );
  });

  it("refuses a run result that carries a plan but no run details", async () => {
    const directory = makeTemporaryDirectory();
    const { binary } = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "run", plan: planPayload() },
    });

    await expect(runTesting({ workspaceRoot: directory, nativeBinary: binary })).rejects.toThrow(
      "The native testing engine returned a run response without run details.",
    );
  });

  it("refuses a response that is not JSON, quoting what the engine wrote to stderr", async () => {
    const directory = makeTemporaryDirectory();
    const binary = createRawNativeBinary(directory, "thread 'main' panicked\n", "manifest not found\n");

    await expect(planTesting({ workspaceRoot: directory, nativeBinary: binary })).rejects.toThrow(
      "The native testing engine did not return JSON: manifest not found",
    );
  });

  it("refuses JSON that is not the native envelope", async () => {
    const directory = makeTemporaryDirectory();
    const cases: readonly unknown[] = [
      null,
      ["plan"],
      { ok: true, result: { operation: "plan", plan: planPayload() } },
      { schemaVersion: 1, result: { operation: "plan", plan: planPayload() } },
      { schemaVersion: "1", ok: true },
      { schemaVersion: 1, ok: "yes" },
    ];

    for (const response of cases) {
      const { binary } = createFakeNativeBinary(directory, response);
      await expect(planTesting({ workspaceRoot: directory, nativeBinary: binary })).rejects.toThrow(
        "The native testing engine returned an invalid response.",
      );
    }
  });
});

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dads-testing-refusal-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** The smallest plan an accepted envelope could carry, so only the envelope is under test. */
function planPayload(): unknown {
  return {
    schemaVersion: 1,
    scope: { kind: "all", changedPaths: [], fullFallback: true },
    tasks: [],
    issues: [],
    complete: true,
    counts: { run: 0, skipProvenUnaffected: 0 },
  };
}

/**
 * An engine that writes bytes rather than a response: the fake in
 * `test-support` always emits valid JSON, and the parse failure needs output
 * that is not.
 */
function createRawNativeBinary(directory: string, stdout: string, stderr: string): string {
  const binary = join(directory, "raw-native-binary.mjs");
  writeFileSync(
    binary,
    [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      'process.stdin.on("data", () => {});',
      'process.stdin.on("end", () => {',
      `  process.stdout.write(${JSON.stringify(stdout)});`,
      `  process.stderr.write(${JSON.stringify(stderr)});`,
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(binary, 0o755);
  return binary;
}
