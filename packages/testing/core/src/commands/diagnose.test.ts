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
    estimatedLeafSkipPercent: 12.5,
    potentialLeafSkipPercent: 84.5,
  },
  workspaceUncertainties: [
    {
      code: "workspace-tsconfig-error",
      path: "tsconfig.json",
      scope: "workspace",
      message: "Unable to parse tsconfig.",
      widenedProjects: 4,
      widenedTasks: 8,
      widenedTestFiles: 30,
      remediation: {
        safety: "keep-widened-unless-verified",
        action: "Fix tsconfig syntax.",
        caution: "Widening protects soundness.",
        verify: "Re-run dad-test diagnose.",
      },
    },
  ],
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
      remediation: {
        safety: "safe",
        action: "Replace dynamic import with a static map.",
        caution: "Do not suppress this file if tests execute it.",
        verify: "Re-run dad-test diagnose.",
      },
    },
    {
      code: "workspace-tsconfig-error",
      path: "tsconfig.json",
      scope: "workspace",
      message: "Unable to parse tsconfig.",
      widenedProjects: 4,
      widenedTasks: 8,
      widenedTestFiles: 30,
      remediation: {
        safety: "keep-widened-unless-verified",
        action: "Fix tsconfig syntax.",
        caution: "Widening protects soundness.",
        verify: "Re-run dad-test diagnose.",
      },
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
      typecheckReachedTestFiles: 25,
      remediation: {
        safety: "safe",
        action: "Split barrel by domain.",
        caution: "Keep public exports until callers migrate.",
        verify: "Re-run dad-test diagnose.",
      },
    },
  ],
  fallbackTraps: [
    {
      kind: "unowned-directory",
      prefix: "docs/",
      fileCount: 5,
      samplePaths: ["docs/guide.md", "docs/faq.md"],
      remediation: {
        safety: "safe",
        action: "Declare a docs project with no tasks.",
        caution: "Only if no test reads docs/.",
        verify: "Check dad-test plan on a docs edit.",
      },
    },
    {
      kind: "non-code-in-reachability-project",
      prefix: "*.json in core",
      fileCount: 1,
      samplePaths: ["packages/core/fixture.json"],
      project: "core",
      remediation: {
        safety: "keep-widened-unless-verified",
        action: "Keep widened by default.",
        caution: "NEVER blindly add .json to nonCodeSuffixes.",
        verify: "Audit tests before excluding.",
      },
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
      "diagnose: 120 modules, 4 projects, 8 tasks, 30 test files, 2 uncertainties (1 workspace-wide)",
    );
    expect(output).toContain("leaf skip: 12.5% effective today -> 84.5% potential after fixing widening culprits");
    expect(output).toContain(
      "packages/core/src/loader.ts:12:4 [nonliteral-dynamic-import] -> widens 4 tasks / 20 test files",
    );
    expect(output).toContain("fix [safe]: Replace dynamic import with a static map.");
    expect(output).toContain("tsconfig.json [workspace-tsconfig-error] -> widens 8 tasks / 30 test files");
    expect(output).toContain(
      "packages/core/src/index.ts -> reaches 18 runtime test files (60%) / 25 with types across 3 projects",
    );
    expect(output).toContain("[unowned-directory] docs/ (5 files, e.g. docs/guide.md)");
    expect(output).toContain(
      "[non-code-in-reachability-project] *.json in core (1 file, e.g. packages/core/fixture.json)",
    );
    expect(output).toContain("fix [keep-widened-unless-verified]: Keep widened by default.");
    expect(output).toContain("caution: NEVER blindly add .json to nonCodeSuffixes.");
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
        potentialLeafSkipPercent: 0,
      },
      workspaceUncertainties: [],
      wideningCulprits: [],
      couplingHotspots: [],
      fallbackTraps: [],
    });

    expect(rendered).toContain("Widening culprits: none");
    expect(rendered).toContain("Coupling hotspots: none");
    expect(rendered).toContain("Fallback traps: none");
    expect(rendered).toContain("1 project, 1 task");
  });

  it("uses singular nouns for single-item hotspots and clarifies workspace-wide culprits", () => {
    const rendered = renderDiagnosis({
      ...sampleDiagnosis,
      couplingHotspots: [
        {
          path: "packages/app-a/src/index.ts",
          project: "app-a",
          reachedModules: 2,
          reachedProjects: 1,
          reachedTestFiles: 1,
          reachedTestPercent: 20,
          typecheckReachedTestFiles: 1,
          remediation: {
            safety: "safe",
            action: "Local leaf module.",
            caution: "Keep exports narrow.",
            verify: "No change required.",
          },
        },
      ],
    });
    expect(rendered).toContain("packages/app-a/src/index.ts -> reaches 1 runtime test file (20%) across 1 project");
    expect(rendered).toContain(
      "tsconfig.json [workspace-tsconfig-error] -> widens 8 tasks / 30 test files (worst-case workspace-wide)",
    );
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

  it("enforces --max-workspace-uncertainties, --fail-on-workspace-uncertainties, and --max-unowned-files ratchets", async () => {
    const directory = makeTemporaryDirectory();
    const fixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "diagnose", plan: emptyPlan, diagnose: sampleDiagnosis },
    });

    const passHarness = createHarness(directory, fixture.binary);
    expect(
      await runDadTestCli(
        ["diagnose", "--max-workspace-uncertainties", "1", "--max-unowned-files", "5"],
        passHarness.io,
      ),
    ).toBe(0);

    const failWsHarness = createHarness(directory, fixture.binary);
    expect(await runDadTestCli(["diagnose", "--fail-on-workspace-uncertainties"], failWsHarness.io)).toBe(1);
    expect(failWsHarness.stderr()).toContain("1 workspace-wide uncertainties (max allowed: 0)");
    expect(failWsHarness.stderr()).toContain("tsconfig.json [workspace-tsconfig-error]");

    const failUnownedHarness = createHarness(directory, fixture.binary);
    expect(await runDadTestCli(["diagnose", "--max-unowned-files", "2"], failUnownedHarness.io)).toBe(1);
    expect(failUnownedHarness.stderr()).toContain("5 unowned tracked files (max allowed: 2)");
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
