import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runDadTestCli, type DadTestCliIo } from "./dad-test-cli.js";
import { createFakeNativeBinary } from "./test-support/native-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const packageDirectory = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const builtCli = join(packageDirectory, "dist", "cli.js");

const planResult = {
  schemaVersion: 1,
  scope: { kind: "working-tree", changedPaths: [], fullFallback: false },
  tasks: [],
  issues: [],
  complete: true,
  counts: { run: 0, skipProvenUnaffected: 0 },
};

describe("dad-test command line", () => {
  it("writes the versioned envelope and sends one plan request", async () => {
    const directory = makeTemporaryDirectory();
    const fixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "plan", plan: planResult },
    });
    const harness = createHarness(directory, fixture.binary);

    const exitCode = await runDadTestCli(["plan", "--json"], harness.io);

    expect(exitCode).toBe(0);
    expect(harness.stdout()).toBe(`${JSON.stringify({ schemaVersion: 1, ok: true, result: planResult })}\n`);
    expect(harness.stderr()).toBe("");
    expect(fixture.readRequest()).toEqual({
      schemaVersion: 1,
      operation: "plan",
      workspaceRoot: directory,
      all: false,
      taskIds: [],
    });
  });

  it("returns the run exit code and forwards the worker limit", async () => {
    const directory = makeTemporaryDirectory();
    const fixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: {
        operation: "run",
        plan: planResult,
        run: {
          tasks: [{ id: "api:test", status: "failed", exitCode: 3 }],
          counts: { executed: 0, failed: 1, blocked: 0, notApplicable: 0 },
          exitCode: 3,
        },
      },
    });
    const harness = createHarness(directory, fixture.binary);

    const exitCode = await runDadTestCli(["run", "--all", "--jobs", "2", "--json"], harness.io);

    expect(exitCode).toBe(3);
    expect(fixture.readRequest()).toMatchObject({
      operation: "run",
      all: true,
      jobs: 2,
      taskIds: [],
    });
  });

  it("prints a human first line without --json", async () => {
    const directory = makeTemporaryDirectory();
    const fixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "plan", plan: planResult },
    });
    const harness = createHarness(directory, fixture.binary);

    const exitCode = await runDadTestCli(["plan"], harness.io);

    expect(exitCode).toBe(0);
    expect(harness.stdout().split("\n")[0]).toBe(
      "plan completed. Use --json for the versioned machine-readable result.",
    );
  });

  it("names every operation when the operation is missing or unknown", async () => {
    const harness = createHarness();
    expect(await runDadTestCli(["frobnicate"], harness.io)).toBe(1);
    expect(harness.stderr()).toBe(
      "dad-test: Expected operation plan, run, explain, diagnose, hotspots, init, or expand.\n",
    );

    const jsonHarness = createHarness();
    expect(await runDadTestCli(["frobnicate", "--json"], jsonHarness.io)).toBe(1);
    expect(jsonHarness.stderr()).toBe(
      `${JSON.stringify({
        schemaVersion: 1,
        ok: false,
        error: "Expected operation plan, run, explain, diagnose, hotspots, init, or expand.",
      })}\n`,
    );
  });

  it("prints full usage with subcommands and options for --help", async () => {
    const harness = createHarness();

    const exitCode = await runDadTestCli(["--help"], harness.io);

    expect(exitCode).toBe(0);
    const usage = harness.stdout();
    for (const operation of ["plan", "run", "explain", "diagnose", "hotspots", "init", "dad-test-nx"]) {
      expect(usage).toContain(operation);
    }
    expect(harness.stderr()).toBe("");
  });

  const commandLineFailures = [
    { argv: ["plan", "--base"], message: "--base requires a value." },
    { argv: ["plan", "--what"], message: "Unknown option --what." },
    {
      argv: ["plan", "--jobs", "0"],
      message: "--jobs must be a positive integer.",
    },
    {
      argv: ["plan", "--base", "a", "--base", "b"],
      message: "--base may only be provided once.",
    },
    { argv: ["plan", "extra"], message: "Unexpected argument extra." },
  ];

  for (const failure of commandLineFailures) {
    it(`rejects ${failure.argv.join(" ")}`, async () => {
      const harness = createHarness();

      const exitCode = await runDadTestCli(failure.argv, harness.io);

      expect(exitCode).toBe(1);
      expect(harness.stderr()).toBe(`dad-test: ${failure.message}\n`);
      expect(harness.stdout()).toBe("");
    });
  }
});

const spawnTestName = "runs plan through the published bin with DADS_TEST_NATIVE_BINARY";

function spawnPublishedBin(): void {
  const directory = makeTemporaryDirectory();
  const fixture = createFakeNativeBinary(directory, {
    schemaVersion: 1,
    ok: true,
    result: { operation: "plan", plan: planResult },
  });
  const result = spawnSync(process.execPath, [join(packageDirectory, "bin", "dad-test.js"), "plan", "--json"], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, DADS_TEST_NATIVE_BINARY: fixture.binary },
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const envelope: unknown = JSON.parse(result.stdout);
  expect(envelope).toMatchObject({ schemaVersion: 1, ok: true });
}

// Gated, not deleted: dist/cli.js exists only after the package typecheck.
it.skipIf(!existsSync(builtCli))(spawnTestName, spawnPublishedBin);

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dads-testing-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createHarness(
  cwd?: string,
  nativeBinary?: string,
): {
  readonly io: DadTestCliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const io: DadTestCliIo = {
    cwd: cwd ?? process.cwd(),
    env: {},
    stdout: (text) => {
      stdoutChunks.push(text);
    },
    stderr: (text) => {
      stderrChunks.push(text);
    },
    ...(nativeBinary === undefined ? {} : { nativeBinary }),
  };
  return {
    io,
    stdout: () => stdoutChunks.join(""),
    stderr: () => stderrChunks.join(""),
  };
}
