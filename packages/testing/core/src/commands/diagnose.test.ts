import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDadTestCli, type DadTestCliIo } from "../dad-test-cli.js";
import { createFakeNativeBinary } from "../test-support/native-fixture.js";
import type { TestingDiagnoseResult } from "../testing-api.js";
import { renderDiagnosis } from "./diagnose.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const emptyPlan = {
  schemaVersion: 1,
  scope: { kind: "diagnose", changedPaths: [], fullFallback: false },
  tasks: [],
  issues: [],
  complete: true,
  counts: { run: 0, skipProvenUnaffected: 0 },
};

const sampleDiagnosis: TestingDiagnoseResult = {
  schemaVersion: 1,
  summary: {
    totalModules: 120,
    totalProjects: 4,
    totalTasks: 8,
    totalTestFiles: 30,
    totalUncertainties: 2,
    wholeWorkspaceUncertainties: 1,
    unownedTrackedFiles: 5,
    nonCodeUncoveredFiles: 3,
    estimatedLeafSkipPercent: 84.5,
  },
  wideningCulprits: [
    {
      code: "nonliteral-dynamic-import",
      path: "packages/core/src/loader.ts",
      line: 12,
      column: 4,
      scope: "module",
      project: "core",
      message: "Dynamic import is not a string literal.",
      widenedProjects: 2,
      widenedTasks: 4,
      widenedTestFiles: 20,
    },
    {
      code: "workspace-tsconfig-error",
      path: "tsconfig.json",
      scope: "workspace",
      message: "Unable to parse tsconfig.",
      widenedProjects: 4,
      widenedTasks: 8,
      widenedTestFiles: 30,
    },
  ],
  couplingHotspots: [
    {
      path: "packages/core/src/index.ts",
      project: "core",
      reachedModules: 42,
      reachedProjects: 3,
      reachedTestFiles: 18,
      reachedTestPercent: 60,
    },
  ],
  fallbackTraps: [
    {
      kind: "unowned-directory",
      prefix: "docs/",
      fileCount: 5,
      samplePaths: ["docs/guide.md", "docs/faq.md"],
    },
    {
      kind: "non-code-in-reachability-project",
      prefix: "*.json in core",
      fileCount: 1,
      samplePaths: ["packages/core/fixture.json"],
      project: "core",
    },
  ],
};

describe("dad-test diagnose", () => {
  it("writes the versioned JSON envelope and forwards --manifest", async () => {
    const directory = makeTemporaryDirectory();
    const fixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "diagnose", plan: emptyPlan, diagnose: sampleDiagnosis },
    });
    const harness = createHarness(directory, fixture.binary);

    const exitCode = await runDadTestCli(["diagnose", "--manifest", "custom.json", "--json"], harness.io);

    expect(exitCode).toBe(0);
    expect(harness.stderr()).toBe("");
    expect(harness.stdout()).toBe(`${JSON.stringify({ schemaVersion: 1, ok: true, result: sampleDiagnosis })}\n`);
    expect(fixture.readRequest()).toEqual({
      schemaVersion: 1,
      operation: "diagnose",
      workspaceRoot: directory,
      manifestPath: "custom.json",
      all: false,
      taskIds: [],
    });
  });

  it("prints a scannable human report without --json", async () => {
    const directory = makeTemporaryDirectory();
    const fixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "diagnose", plan: emptyPlan, diagnose: sampleDiagnosis },
    });
    const harness = createHarness(directory, fixture.binary);

    const exitCode = await runDadTestCli(["diagnose"], harness.io);

    expect(exitCode).toBe(0);
    expect(harness.stderr()).toBe("");
    const output = harness.stdout();
    expect(output).toContain(
      "diagnose: 120 modules, 4 projects, 8 tasks, 30 test files, 2 uncertainties (1 workspace-wide), est. leaf skip 84.5%",
    );
    expect(output).toContain(
      "packages/core/src/loader.ts:12:4 [nonliteral-dynamic-import] -> widens 4 tasks / 20 test files",
    );
    expect(output).toContain("tsconfig.json [workspace-tsconfig-error] -> widens 8 tasks / 30 test files");
    expect(output).toContain("packages/core/src/index.ts -> reaches 18 test files (60%) across 3 projects");
    expect(output).toContain("[unowned-directory] docs/ (5 files, e.g. docs/guide.md)");
    expect(output).toContain(
      "[non-code-in-reachability-project] *.json in core (1 file, e.g. packages/core/fixture.json)",
    );
  });

  it("renders empty sections cleanly", () => {
    const rendered = renderDiagnosis({
      schemaVersion: 1,
      summary: {
        totalModules: 0,
        totalProjects: 1,
        totalTasks: 1,
        totalTestFiles: 0,
        totalUncertainties: 0,
        wholeWorkspaceUncertainties: 0,
        unownedTrackedFiles: 0,
        nonCodeUncoveredFiles: 0,
        estimatedLeafSkipPercent: 0,
      },
      wideningCulprits: [],
      couplingHotspots: [],
      fallbackTraps: [],
    });

    expect(rendered).toContain("Widening culprits: none");
    expect(rendered).toContain("Coupling hotspots: none");
    expect(rendered).toContain("Fallback traps: none");
  });

  it("fails loudly if the native binary omits diagnose details", async () => {
    const directory = makeTemporaryDirectory();
    const fixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "diagnose", plan: emptyPlan },
    });
    const harness = createHarness(directory, fixture.binary);

    const exitCode = await runDadTestCli(["diagnose", "--json"], harness.io);

    expect(exitCode).toBe(1);
    expect(harness.stdout()).toBe("");
    expect(harness.stderr()).toContain("without diagnose details");
  });
});

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dads-testing-diagnose-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createHarness(
  cwd: string,
  nativeBinary: string,
): {
  readonly io: DadTestCliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const io: DadTestCliIo = {
    cwd,
    env: {},
    stdout: (text) => {
      stdoutChunks.push(text);
    },
    stderr: (text) => {
      stderrChunks.push(text);
    },
    nativeBinary,
  };
  return {
    io,
    stdout: () => stdoutChunks.join(""),
    stderr: () => stderrChunks.join(""),
  };
}
