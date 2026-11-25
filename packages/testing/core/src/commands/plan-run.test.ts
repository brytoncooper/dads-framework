import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDadTestCli } from "../dad-test-cli.js";
import type { DadTestCliIo } from "../dad-test-cli.js";
import { createFakeNativeBinary } from "../test-support/native-fixture.js";
import type { TestingReport } from "../testing-report.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** One project, one task, so the project closure a `--report` computes is easy to check by hand. */
const singleProjectManifest = JSON.stringify({
  schemaVersion: 1,
  workspace: { fullFallback: { taskIds: ["api:test"] } },
  projects: [{ id: "api", root: "apps/api", fallbackDependencies: [] }],
  tasks: [
    {
      id: "api:test",
      project: "api",
      kind: "test",
      execution: { executable: "true" },
      dependsOn: [],
      impact: { mode: "always" },
    },
  ],
});

const planResult = {
  schemaVersion: 1,
  scope: {
    kind: "working-tree",
    changedPaths: ["apps/api/src/x.ts"],
    fullFallback: false,
  },
  tasks: [
    {
      id: "api:test",
      decision: "run",
      reason: "changed-path",
      confidence: "proven",
      widened: false,
    },
  ],
  issues: [],
  complete: true,
  counts: { run: 1, skipProvenUnaffected: 0 },
};

const runResult = {
  tasks: [{ id: "api:test", status: "executed", exitCode: 0, durationMs: 5 }],
  counts: { executed: 1, failed: 0, blocked: 0, notApplicable: 0 },
  exitCode: 0,
};

/** What `buildTestingReport` produces for `planResult` against `singleProjectManifest`, with no run. */
const expectedPlanReport: TestingReport = {
  schemaVersion: 1,
  kind: "dads-testing-report",
  scope: {
    kind: "working-tree",
    changedPaths: ["apps/api/src/x.ts"],
    fullFallback: false,
  },
  totals: {
    tasks: 1,
    selected: 1,
    skipped: 0,
    widened: 0,
    byReason: { "changed-path": 1 },
    byConfidence: { proven: 1 },
  },
  fallback: {
    full: false,
    forcedBy: [],
    issuesByCode: {},
    issuesBySeverity: { info: 0, uncertainty: 0, error: 0 },
    widening: [],
  },
  projectClosure: {
    changedProjects: ["api"],
    unownedChangedPaths: [],
    closureProjects: ["api"],
    closureTaskIds: ["api:test"],
    closureTaskCount: 1,
    selectedTaskCount: 1,
    reductionRatio: 1,
  },
  execution: null,
  receipts: [
    {
      taskId: "api:test",
      decision: "run",
      reason: "changed-path",
      status: "planned",
    },
  ],
};

/** The same report, with `runResult` merged in. */
const expectedRunReport: TestingReport = {
  ...expectedPlanReport,
  execution: {
    tasks: [{ id: "api:test", status: "executed", exitCode: 0, durationMs: 5 }],
    counts: { executed: 1, failed: 0, blocked: 0, notApplicable: 0 },
    exitCode: 0,
    totalTaskDurationMs: 5,
    wallClockMs: null,
  },
  receipts: [
    {
      taskId: "api:test",
      decision: "run",
      reason: "changed-path",
      status: "executed",
      exitCode: 0,
      durationMs: 5,
    },
  ],
};

describe("plan/run --report", () => {
  it("leaves plan --json output unchanged when --report is absent", async () => {
    const directory = makeManifestDirectory();
    const fixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "plan", plan: planResult },
    });
    const harness = createHarness(directory, fixture.binary);

    const exitCode = await runDadTestCli(["plan", "--json"], harness.io);

    expect(exitCode).toBe(0);
    expect(harness.stdout()).toBe(`${JSON.stringify({ schemaVersion: 1, ok: true, result: planResult })}\n`);
  });

  it("writes the report file and embeds it when --report has a value", async () => {
    const directory = makeManifestDirectory();
    const fixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "plan", plan: planResult },
    });
    const harness = createHarness(directory, fixture.binary);

    const exitCode = await runDadTestCli(["plan", "--report", "r.json", "--json"], harness.io);

    expect(exitCode).toBe(0);
    const envelope: unknown = JSON.parse(harness.stdout());
    expect(envelope).toEqual({
      schemaVersion: 1,
      ok: true,
      result: { ...planResult, report: expectedPlanReport },
    });
    const written: unknown = JSON.parse(readFileSync(join(directory, "r.json"), "utf8"));
    expect(written).toEqual(expectedPlanReport);
  });

  it("embeds the report without writing a file when --report has no value", async () => {
    const directory = makeManifestDirectory();
    const filesBefore = readdirSync(directory).sort();
    const fixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "plan", plan: planResult },
    });
    const harness = createHarness(directory, fixture.binary);

    const exitCode = await runDadTestCli(["plan", "--report", "--json"], harness.io);

    expect(exitCode).toBe(0);
    const envelope: unknown = JSON.parse(harness.stdout());
    expect(envelope).toEqual({
      schemaVersion: 1,
      ok: true,
      result: { ...planResult, report: expectedPlanReport },
    });
    expect(readdirSync(directory).sort()).toEqual([...filesBefore, "fake-native-binary.mjs", "request.json"].sort());
  });

  it("prints the report-written line in human mode after a run", async () => {
    const directory = makeManifestDirectory();
    const fixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "run", plan: planResult, run: runResult },
    });
    const harness = createHarness(directory, fixture.binary);

    const exitCode = await runDadTestCli(["run", "--all", "--report", "out.json"], harness.io);

    expect(exitCode).toBe(0);
    expect(harness.stdout()).toContain("run completed.");
    expect(harness.stdout().endsWith("report written: out.json\n")).toBe(true);
    const written: unknown = JSON.parse(readFileSync(join(directory, "out.json"), "utf8"));
    expect(written).toEqual(expectedRunReport);
  });

  it("returns an error envelope and exit code 1 when the manifest is missing", async () => {
    const directory = makeTemporaryDirectory();
    const fixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "plan", plan: planResult },
    });
    const harness = createHarness(directory, fixture.binary);

    const exitCode = await runDadTestCli(["plan", "--report", "r.json", "--json"], harness.io);

    expect(exitCode).toBe(1);
    expect(harness.stdout()).toBe("");
    const envelope: unknown = JSON.parse(harness.stderr());
    expect(envelope).toMatchObject({ schemaVersion: 1, ok: false });
    expect(harness.stderr()).toContain("dads.testing.json");
  });

  it("forwards --cache and lets --no-cache disable receipt reuse", async () => {
    const directory = makeManifestDirectory();
    const fixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "run", plan: planResult, run: runResult },
    });
    const harness = createHarness(directory, fixture.binary);

    expect(await runDadTestCli(["run", "--all", "--cache", "--json"], harness.io)).toBe(0);
    expect(fixture.readRequest()).toMatchObject({ operation: "run", cache: true });

    expect(await runDadTestCli(["run", "--all", "--cache", "--no-cache", "--json"], harness.io)).toBe(0);
    expect(fixture.readRequest()).not.toHaveProperty("cache");

    expect(
      await runDadTestCli(
        ["run", "--all", "--cache", "--remote-cache", "http://127.0.0.1:9000/cache", "--json"],
        harness.io,
      ),
    ).toBe(0);
    expect(fixture.readRequest()).toMatchObject({
      operation: "run",
      cache: true,
      remoteCacheUrl: "http://127.0.0.1:9000/cache",
    });

    expect(
      await runDadTestCli(
        [
          "run",
          "--all",
          "--kind",
          "test",
          "--kind",
          "lint",
          "--shard",
          "2/4",
          "--cache",
          "--remote-cache",
          "s3://example-cache-bucket/dad-test/v1",
          "--json",
        ],
        harness.io,
      ),
    ).toBe(0);
    expect(fixture.readRequest()).toMatchObject({
      operation: "run",
      taskKinds: ["test", "lint"],
      shard: { index: 2, total: 4 },
      cache: true,
      remoteCacheUrl: "s3://example-cache-bucket/dad-test/v1",
    });

    expect(await runDadTestCli(["plan", "--all", "--shard", "5/4", "--json"], harness.io)).toBe(1);
    expect(await runDadTestCli(["plan", "--all", "--shard", "bad", "--json"], harness.io)).toBe(1);
  });

  it("resolves --cache-dir and DAD_TEST_CACHE_DIR with flag precedence and tilde expansion", async () => {
    const directory = makeManifestDirectory();
    const fixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "run", plan: planResult, run: runResult },
    });

    // 1. DAD_TEST_CACHE_DIR env var is forwarded when --cache-dir is absent
    const envHarness = createHarness(directory, fixture.binary, {
      HOME: "/tmp/fake-home",
      DAD_TEST_CACHE_DIR: "~/.cache/dad-test",
    });
    expect(await runDadTestCli(["run", "--all", "--cache", "--json"], envHarness.io)).toBe(0);
    expect(fixture.readRequest()).toMatchObject({
      operation: "run",
      cache: true,
      cacheDir: resolve("/tmp/fake-home", ".cache/dad-test"),
    });

    // 2. --cache-dir overrides DAD_TEST_CACHE_DIR and resolves relative paths against cwd
    expect(
      await runDadTestCli(["run", "--all", "--cache", "--cache-dir", "shared-cache", "--json"], envHarness.io),
    ).toBe(0);
    expect(fixture.readRequest()).toMatchObject({
      operation: "run",
      cache: true,
      cacheDir: resolve(directory, "shared-cache"),
    });

    // 3. Whitespace-only DAD_TEST_CACHE_DIR is ignored
    const blankEnvHarness = createHarness(directory, fixture.binary, {
      DAD_TEST_CACHE_DIR: "   ",
    });
    expect(await runDadTestCli(["run", "--all", "--cache", "--json"], blankEnvHarness.io)).toBe(0);
    expect(fixture.readRequest()).not.toHaveProperty("cacheDir");

    // 4. Empty --cache-dir is rejected cleanly
    const emptyFlagHarness = createHarness(directory, fixture.binary);
    expect(await runDadTestCli(["run", "--all", "--cache", "--cache-dir", "   ", "--json"], emptyFlagHarness.io)).toBe(
      1,
    );
    expect(emptyFlagHarness.stderr()).toContain("--cache-dir must not be empty.");
  });

  it("forwards --target, --project, --exclude, --weights, --stream, and expand", async () => {
    const directory = makeManifestDirectory();
    writeFileSync(join(directory, "weights.json"), JSON.stringify({ api: 120, web: 40 }), "utf8");
    const fixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "run", plan: planResult, run: runResult },
    });
    const harness = createHarness(directory, fixture.binary);

    expect(
      await runDadTestCli(
        [
          "run",
          "--all",
          "--target",
          "lint,lint-typed",
          "--project",
          "api",
          "--exclude",
          "legacy",
          "--shard",
          "1/2",
          "--weights",
          "weights.json",
          "--stream",
          "--json",
        ],
        harness.io,
      ),
    ).toBe(0);
    expect(fixture.readRequest()).toMatchObject({
      operation: "run",
      targets: ["lint", "lint-typed"],
      projects: ["api"],
      excludeProjects: ["legacy"],
      shard: { index: 1, total: 2 },
      shardWeights: { api: 120, web: 40 },
      stream: true,
    });

    // `--only --task` forwards `only: true` and human `run` emits a concise summary without dumping JSON.
    const humanHarness = createHarness(directory, fixture.binary);
    expect(await runDadTestCli(["run", "--only", "--task", "api:test"], humanHarness.io)).toBe(0);
    expect(fixture.readRequest()).toMatchObject({ operation: "run", only: true, taskIds: ["api:test"], stream: true });
    expect(humanHarness.stdout()).toContain("run completed.");
    expect(humanHarness.stdout()).not.toContain('"tasks": [');

    const parsedManifest: unknown = JSON.parse(singleProjectManifest);
    const expandFixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: {
        operation: "expand-manifest",
        plan: planResult,
        manifest: parsedManifest,
      },
    });
    const expandHarness = createHarness(directory, expandFixture.binary);
    expect(await runDadTestCli(["expand", "--out", "expanded.json", "--json"], expandHarness.io)).toBe(0);
    expect(expandFixture.readRequest()).toMatchObject({ operation: "expand-manifest" });
    expect(JSON.parse(readFileSync(join(directory, "expanded.json"), "utf8"))).toMatchObject({ schemaVersion: 1 });
  });

  it("parses nested projects durationMs weights files and forwards --plan-file on run", async () => {
    const directory = makeManifestDirectory();
    writeFileSync(
      join(directory, "integration-weights.json"),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: "2026-01-01T00:00:00Z",
        projects: {
          api: { durationMs: 4200, budgetMs: 10000 },
          web: { durationMs: 0 },
          worker: 850,
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(directory, "plan.json"),
      JSON.stringify({ schemaVersion: 1, ok: true, result: planResult }),
      "utf8",
    );

    const shardedPlanResult = {
      ...planResult,
      shard: {
        index: 1,
        total: 2,
        weighted: true,
        totalProjects: 2,
        selectedProjects: 1,
        totalRunnableTasks: 2,
        selectedRunnableTasks: 1,
        shardWeight: 4200,
        totalWeight: 5050,
      },
    };
    const runFixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "run", plan: shardedPlanResult, run: runResult },
    });
    const runHarness = createHarness(directory, runFixture.binary);

    expect(
      await runDadTestCli(
        ["run", "--plan-file", "plan.json", "--shard", "1/2", "--weights", "integration-weights.json", "--json"],
        runHarness.io,
      ),
    ).toBe(0);
    expect(runFixture.readRequest()).toMatchObject({
      operation: "run",
      planFile: join(directory, "plan.json"),
      shard: { index: 1, total: 2 },
      shardWeights: { api: 4200, web: 1, worker: 850 },
    });
    const runEnvelope: unknown = JSON.parse(runHarness.stdout());
    expect(runEnvelope).toMatchObject({
      schemaVersion: 1,
      ok: true,
      result: {
        plan: { shard: shardedPlanResult.shard },
      },
    });

    // --plan-file is only accepted by `run`, not `plan`.
    const planFixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: { operation: "plan", plan: shardedPlanResult },
    });
    const planHarness = createHarness(directory, planFixture.binary);
    expect(await runDadTestCli(["plan", "--plan-file", "plan.json", "--json"], planHarness.io)).toBe(1);

    // Invalid nested weights entry fails closed.
    writeFileSync(
      join(directory, "bad-weights.json"),
      JSON.stringify({ projects: { api: { durationMs: -5 } } }),
      "utf8",
    );
    const badHarness = createHarness(directory, planFixture.binary);
    expect(
      await runDadTestCli(
        ["plan", "--all", "--shard", "1/2", "--weights", "bad-weights.json", "--json"],
        badHarness.io,
      ),
    ).toBe(1);
    expect(badHarness.stderr()).toContain("durationMs");
  });
});

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dads-testing-plan-run-"));
  temporaryDirectories.push(directory);
  return directory;
}

function makeManifestDirectory(): string {
  const directory = makeTemporaryDirectory();
  writeFileSync(join(directory, "dads.testing.json"), singleProjectManifest, "utf8");
  return directory;
}

function createHarness(
  cwd: string,
  nativeBinary: string,
  env: NodeJS.ProcessEnv = {},
): {
  readonly io: DadTestCliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const io: DadTestCliIo = {
    cwd,
    env,
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
