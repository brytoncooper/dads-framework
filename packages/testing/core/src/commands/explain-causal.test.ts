import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDadTestCli, type DadTestCliIo } from "../dad-test-cli.js";
import { explainPlan } from "../explain-plan.js";
import { createFakeNativeBinary } from "../test-support/native-fixture.js";
import type { TestingPlanResult } from "../testing-api.js";
import type { TestingManifest } from "../testing-manifest.js";
import { buildFocusedTaskExplanation, renderFocusedTaskExplanation } from "./explain-causal.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const manifestDocument: TestingManifest = {
  schemaVersion: 1,
  workspace: { root: ".", fullFallback: { taskIds: ["core:test", "web:test", "docs:test"] } },
  projects: [
    { id: "core", root: "packages/core", fallbackDependencies: [] },
    { id: "web", root: "packages/web", fallbackDependencies: ["core"] },
    { id: "docs", root: "packages/docs", fallbackDependencies: [] },
  ],
  tasks: [
    {
      id: "core:test",
      project: "core",
      kind: "test",
      execution: { executable: "true", args: [] },
      dependsOn: [],
      impact: { mode: "reachability", paths: [] },
    },
    {
      id: "web:test",
      project: "web",
      kind: "test",
      execution: { executable: "true", args: [] },
      dependsOn: [],
      impact: { mode: "reachability", paths: [] },
    },
    {
      id: "docs:test",
      project: "docs",
      kind: "test",
      execution: { executable: "true", args: [] },
      dependsOn: [],
      impact: { mode: "reachability", paths: [] },
    },
  ],
};

const richPlan: TestingPlanResult = {
  schemaVersion: 1,
  scope: {
    kind: "base-to-working-tree",
    base: "main",
    changedPaths: ["packages/core/src/loader.ts"],
    fullFallback: false,
  },
  tasks: [
    {
      id: "core:test",
      project: "core",
      decision: "run",
      reason: "graph-uncertainty-project-fallback",
      confidence: "widened",
      widened: true,
      causes: [{ kind: "issue", index: 0 }],
    },
    {
      id: "web:test",
      project: "web",
      decision: "run",
      reason: "graph-symbol-importer",
      confidence: "proven",
      widened: false,
      causes: [
        {
          kind: "reached-import",
          path: "packages/web/src/app.ts",
          line: 8,
          column: 1,
          importedFrom: "packages/core/src/loader.ts",
          symbols: ["loadPlugin"],
        },
      ],
    },
    {
      id: "docs:test",
      project: "docs",
      decision: "skip-proven-unaffected",
      reason: "proven-unaffected",
      confidence: "proven",
      widened: false,
      causes: [],
    },
  ],
  issues: [
    {
      code: "nonliteral-dynamic-import",
      message: "Dynamic import cannot be statically resolved.",
      severity: "uncertainty",
      scope: "module",
      path: "packages/core/src/loader.ts",
      line: 12,
      column: 4,
      project: "core",
    },
  ],
  complete: true,
  counts: { run: 2, skipProvenUnaffected: 1 },
};

describe("dad-test explain --why", () => {
  it("plans without forcing --task and prints a 3-line causal chain + actionable fix for a widened task", async () => {
    const workspace = makeWorkspace(richPlan);
    const harness = createHarness(workspace.directory, workspace.nativeBinary);

    const exitCode = await runDadTestCli(["explain", "--why", "core:test", "--base", "main"], harness.io);

    expect(exitCode).toBe(0);
    expect(harness.stderr()).toBe("");
    expect(workspace.readRequest()).toMatchObject({
      operation: "plan",
      base: "main",
      taskIds: [],
    });
    expect(harness.stdout()).toBe(
      [
        "why core:test: RUN (graph-uncertainty-project-fallback, widened=yes)",
        "  chain: changed packages/core/src/loader.ts:12:4 -> issue nonliteral-dynamic-import -> core:test (widened 1 task)",
        '  fix: add "packages/core/src/loader.ts": ["packages/core"] to workspace.dynamicImportScopes in dads.testing.json (or run npx dad-test diagnose --fix)',
        "",
      ].join("\n"),
    );
  });

  it("emits the structured JSON shape for a proven affected task and a skipped task", async () => {
    const workspace = makeWorkspace(richPlan);

    const runHarness = createHarness(workspace.directory, workspace.nativeBinary);
    expect(await runDadTestCli(["explain", "--why", "web:test", "--json"], runHarness.io)).toBe(0);
    expect(JSON.parse(runHarness.stdout())).toEqual({
      schemaVersion: 1,
      ok: true,
      result: {
        schemaVersion: 1,
        task: {
          id: "web:test",
          project: "web",
          decision: "run",
          reason: "graph-symbol-importer",
          reasonText: "imports a changed symbol",
          confidence: "proven",
          widened: false,
          causes: [
            {
              kind: "reached-import",
              path: "packages/web/src/app.ts",
              location: "packages/web/src/app.ts:8:1",
              importedFrom: "packages/core/src/loader.ts",
              symbols: ["loadPlugin"],
            },
          ],
        },
        chain: [
          "changed packages/core/src/loader.ts",
          "imported by packages/web/src/app.ts:8:1 (loadPlugin)",
          "web:test",
        ],
        widenedTasksCount: 1,
        suggestedFix: "none (proven affected)",
      },
    });

    const skipHarness = createHarness(workspace.directory, workspace.nativeBinary);
    expect(await runDadTestCli(["explain", "--why", "docs:test"], skipHarness.io)).toBe(0);
    expect(skipHarness.stdout()).toBe(
      [
        "why docs:test: SKIP (proven-unaffected, widened=no)",
        "  chain: changed packages/core/src/loader.ts -> no reaching path or symbol -> docs:test (unaffected)",
        "  fix: none (skipped — proven unaffected)",
        "",
      ].join("\n"),
    );
  });

  it("errors with exit code 1 when --why names an unknown task or is combined with --task", async () => {
    const workspace = makeWorkspace(richPlan);

    const unknownHarness = createHarness(workspace.directory, workspace.nativeBinary);
    expect(await runDadTestCli(["explain", "--why", "missing:test"], unknownHarness.io)).toBe(1);
    expect(unknownHarness.stdout()).toBe("");
    expect(unknownHarness.stderr()).toContain("Unknown task 'missing:test' in plan.");
    expect(unknownHarness.stderr()).toContain("core:test, web:test, docs:test");

    const conflictHarness = createHarness(workspace.directory, workspace.nativeBinary);
    expect(await runDadTestCli(["explain", "--why", "core:test", "--task", "core:test"], conflictHarness.io)).toBe(1);
    expect(conflictHarness.stderr()).toContain("--why cannot be combined with --task");
  });

  it("suggests ignorePaths for unowned docs full-fallback, pureFactories for impure exports, and sqlImpact for unmapped SQL", () => {
    const docsFallbackPlan: TestingPlanResult = {
      schemaVersion: 1,
      scope: { kind: "working-tree", changedPaths: ["docs/guide.md"], fullFallback: true },
      tasks: [
        {
          id: "core:test",
          project: "core",
          decision: "run",
          reason: "full-fallback",
          confidence: "widened",
          widened: true,
          causes: [{ kind: "issue", index: 0 }],
        },
        {
          id: "web:test",
          project: "web",
          decision: "run",
          reason: "full-fallback",
          confidence: "widened",
          widened: true,
          causes: [{ kind: "issue", index: 0 }],
        },
      ],
      issues: [
        {
          code: "unknown-changed-path",
          message: "Changed path is not owned by any declared project.",
          severity: "uncertainty",
          scope: "workspace",
          path: "docs/guide.md",
        },
      ],
      complete: true,
      counts: { run: 2, skipProvenUnaffected: 0 },
    };
    const docsFocused = buildFocusedTaskExplanation(
      explainPlan(docsFallbackPlan, manifestDocument),
      "core:test",
      manifestDocument,
    );
    expect(renderFocusedTaskExplanation(docsFocused)).toBe(
      [
        "why core:test: RUN (full-fallback, widened=yes)",
        "  chain: changed docs/guide.md -> issue unknown-changed-path -> core:test (widened 2 tasks)",
        '  fix: add "docs/**" to workspace.ignorePaths in dads.testing.json (or run npx dad-test diagnose --fix)',
        "",
      ].join("\n"),
    );

    const impurePlan: TestingPlanResult = {
      schemaVersion: 1,
      scope: { kind: "working-tree", changedPaths: ["packages/core/src/schema.ts"], fullFallback: false },
      tasks: [
        {
          id: "web:test",
          project: "web",
          decision: "run",
          reason: "graph-uncertainty-project-fallback",
          confidence: "widened",
          widened: true,
          causes: [
            { kind: "issue", index: 0 },
            { kind: "fallback-dependency", project: "core" },
          ],
        },
      ],
      issues: [
        {
          code: "impure-top-level-initializer",
          message: "Top-level initializer is impure; add to pureFactories if side-effect-free.",
          severity: "uncertainty",
          scope: "module",
          path: "packages/core/src/schema.ts",
          line: 4,
          project: "core",
        },
      ],
      complete: true,
      counts: { run: 1, skipProvenUnaffected: 0 },
    };
    const impureFocused = buildFocusedTaskExplanation(
      explainPlan(impurePlan, manifestDocument),
      "web:test",
      manifestDocument,
    );
    expect(impureFocused.suggestedFix).toContain("workspace.pureFactories");
    expect(impureFocused.chain[1]).toContain("fallback-dependency core");

    const sqlPlan: TestingPlanResult = {
      schemaVersion: 1,
      scope: { kind: "working-tree", changedPaths: ["migrations/001.sql"], fullFallback: false },
      tasks: [
        {
          id: "core:test",
          project: "core",
          decision: "run",
          reason: "sql-unmapped-project",
          confidence: "widened",
          widened: true,
          causes: [],
        },
      ],
      issues: [],
      complete: true,
      counts: { run: 1, skipProvenUnaffected: 0 },
    };
    const sqlFocused = buildFocusedTaskExplanation(
      explainPlan(sqlPlan, manifestDocument),
      "core:test",
      manifestDocument,
    );
    expect(sqlFocused.suggestedFix).toContain('sqlImpact.tables on task "core:test"');
  });
});

function makeWorkspace(plan: TestingPlanResult): {
  readonly directory: string;
  readonly nativeBinary: string;
  readonly readRequest: () => unknown;
} {
  const directory = mkdtempSync(join(tmpdir(), "dads-testing-explain-causal-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "dads.testing.json"), JSON.stringify(manifestDocument), "utf8");
  const fixture = createFakeNativeBinary(directory, {
    schemaVersion: 1,
    ok: true,
    result: { operation: "plan", plan },
  });
  return { directory, nativeBinary: fixture.binary, readRequest: fixture.readRequest };
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
  return { io, stdout: () => stdoutChunks.join(""), stderr: () => stderrChunks.join("") };
}
