import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDadTestCli, type DadTestCliIo } from "../dad-test-cli.js";
import { createFakeNativeBinary } from "../test-support/native-fixture.js";
import type { TestingHotspotsResult } from "../testing-api.js";
import { renderHotspots } from "./hotspots.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const emptyPlan = {
  schemaVersion: 1,
  scope: { kind: "hotspots", changedPaths: [], fullFallback: false },
  tasks: [],
  issues: [],
  complete: true,
  counts: { run: 0, skipProvenUnaffected: 0 },
};

const sampleHotspots: TestingHotspotsResult = {
  schemaVersion: 1,
  summary: {
    totalFiles: 120,
    totalBarrels: 14,
    totalProjects: 4,
    limit: 25,
    minProjects: 1,
    barrelsOnly: false,
  },
  files: [
    {
      path: "packages/core/src/index.ts",
      project: "core",
      affectedProjects: 4,
      affectedFiles: 42,
      directImporters: 12,
      isBarrel: true,
    },
    {
      path: "packages/core/src/math.ts",
      project: "core",
      affectedProjects: 3,
      affectedFiles: 18,
      directImporters: 2,
      isBarrel: false,
    },
  ],
  projects: [
    {
      project: "core",
      affectedProjects: 4,
      affectedFiles: 42,
      directDependentProjects: 3,
      fileCount: 18,
      barrelCount: 3,
    },
  ],
};

describe("dad-test hotspots", () => {
  it("writes the versioned JSON envelope and forwards --manifest, --limit, --min-projects, and --barrels-only", async () => {
    const directory = makeTemporaryDirectory();
    const fixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "hotspots", plan: emptyPlan, hotspots: sampleHotspots },
    });
    const harness = createHarness(directory, fixture.binary);

    const exitCode = await runDadTestCli(
      ["hotspots", "--manifest", "custom.json", "--limit", "10", "--min-projects", "2", "--barrels-only", "--json"],
      harness.io,
    );

    expect(exitCode).toBe(0);
    expect(harness.stderr()).toBe("");
    expect(harness.stdout()).toBe(`${JSON.stringify({ schemaVersion: 1, ok: true, result: sampleHotspots })}\n`);
    expect(fixture.readRequest()).toEqual({
      schemaVersion: 1,
      operation: "hotspots",
      workspaceRoot: directory,
      manifestPath: "custom.json",
      all: false,
      taskIds: [],
      hotspots: {
        limit: 10,
        minProjects: 2,
        barrelsOnly: true,
      },
    });
  });

  it("omits the hotspots options block when no filter flags are passed", async () => {
    const directory = makeTemporaryDirectory();
    const fixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "hotspots", plan: emptyPlan, hotspots: sampleHotspots },
    });
    const harness = createHarness(directory, fixture.binary);

    const exitCode = await runDadTestCli(["hotspots", "--json"], harness.io);

    expect(exitCode).toBe(0);
    expect(fixture.readRequest()).toEqual({
      schemaVersion: 1,
      operation: "hotspots",
      workspaceRoot: directory,
      all: false,
      taskIds: [],
    });
  });

  it("renders a scannable human table without --json", async () => {
    const directory = makeTemporaryDirectory();
    const fixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "hotspots", plan: emptyPlan, hotspots: sampleHotspots },
    });
    const harness = createHarness(directory, fixture.binary);

    const exitCode = await runDadTestCli(["hotspots"], harness.io);

    expect(exitCode).toBe(0);
    expect(harness.stderr()).toBe("");
    const output = harness.stdout();
    expect(output).toContain("hotspots: 120 files (14 barrels) across 4 projects (limit 25, min-projects >= 1)");
    expect(output).toContain("Top files (2):");
    expect(output).toContain("PROJECTS  FILES  IMPORTERS  BARREL  PROJECT  PATH");
    expect(output).toContain("yes     core     packages/core/src/index.ts");
    expect(output).toContain("no      core     packages/core/src/math.ts");
    expect(output).toContain("Top projects (1):");
    expect(output).toContain("PROJECTS  FILES  DIRECT_DEPS  TOTAL_FILES  BARRELS  PROJECT");
    expect(output).toContain("core");
  });

  it("renders empty sections and barrels-only header cleanly", () => {
    const rendered = renderHotspots({
      schemaVersion: 1,
      summary: {
        totalFiles: 1,
        totalBarrels: 0,
        totalProjects: 1,
        limit: 5,
        minProjects: 2,
        barrelsOnly: true,
      },
      files: [],
      projects: [],
    });

    expect(rendered).toContain(
      "hotspots: 1 file (0 barrels) across 1 project (limit 5, min-projects >= 2, barrels-only)",
    );
    expect(rendered).toContain("Top files: none");
    expect(rendered).toContain("Top projects: none");
  });

  it("rejects invalid --limit and --min-projects values", async () => {
    const directory = makeTemporaryDirectory();
    const fixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "hotspots", plan: emptyPlan, hotspots: sampleHotspots },
    });

    const zeroLimit = createHarness(directory, fixture.binary);
    expect(await runDadTestCli(["hotspots", "--limit", "0"], zeroLimit.io)).toBe(1);
    expect(zeroLimit.stderr()).toBe("dad-test: --limit must be a positive integer.\n");

    const badMinProjects = createHarness(directory, fixture.binary);
    expect(await runDadTestCli(["hotspots", "--min-projects", "abc"], badMinProjects.io)).toBe(1);
    expect(badMinProjects.stderr()).toBe("dad-test: --min-projects must be a positive integer.\n");
  });

  it("fails loudly if the native binary omits hotspots details", async () => {
    const directory = makeTemporaryDirectory();
    const fixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "hotspots", plan: emptyPlan },
    });
    const harness = createHarness(directory, fixture.binary);

    const exitCode = await runDadTestCli(["hotspots", "--json"], harness.io);

    expect(exitCode).toBe(1);
    expect(harness.stdout()).toBe("");
    expect(harness.stderr()).toContain("without hotspots details");
  });
});

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dads-testing-hotspots-"));
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
