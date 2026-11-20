import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  TestingPlanIssue,
  TestingPlanResult,
  TestingRunResult,
  TestingTaskDecision,
} from "./testing-api.js";
import { buildTestingReport } from "./testing-report.js";
import { parseTestingManifest } from "./testing-manifest.js";
import type { TestingManifest } from "./testing-manifest.js";

const workspaceRoot = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

/**
 * `core` has no fallback dependents of its own; `api` and `web` each declare
 * `core` as a fallback dependency, so a change to `core` reaches both.
 */
const manifest: TestingManifest = parseTestingManifest(
  readFileSync(
    join(workspaceRoot, "fixtures", "testing-soundness", "dads.testing.json"),
    "utf8",
  ),
  "fixtures/testing-soundness/dads.testing.json",
);

const allTaskIds = [
  "core:lint",
  "core:typecheck",
  "core:test",
  "api:lint",
  "api:typecheck",
  "api:test",
  "web:lint",
  "web:typecheck",
  "web:test",
];

describe("testing report", () => {
  it("counts tasks into selected/skipped/widened/byReason/byConfidence and closes the project set across fallback dependents", () => {
    const plan: TestingPlanResult = {
      schemaVersion: 1,
      scope: {
        kind: "working-tree",
        changedPaths: ["packages/core/src/leaf.ts"],
        fullFallback: false,
      },
      tasks: [
        task("core:typecheck", { reason: "changed-path" }),
        task("core:test", { reason: "reached-import" }),
        task("api:typecheck", {
          reason: "fallback-dependency",
          confidence: "conservative",
          widened: true,
        }),
        task("api:test", {
          decision: "skip-proven-unaffected",
          reason: "no-reachable-change",
        }),
        task("web:typecheck", {
          decision: "skip-proven-unaffected",
          reason: "no-reachable-change",
        }),
        task("web:test", {
          decision: "skip-proven-unaffected",
          reason: "no-reachable-change",
        }),
      ],
      issues: [],
      complete: true,
      counts: { run: 3, skipProvenUnaffected: 3 },
    };

    const report = buildTestingReport({ plan, manifest });

    expect(report.totals).toEqual({
      tasks: 6,
      selected: 3,
      skipped: 3,
      widened: 1,
      byReason: {
        "changed-path": 1,
        "reached-import": 1,
        "fallback-dependency": 1,
        "no-reachable-change": 3,
      },
      byConfidence: { proven: 5, conservative: 1 },
    });
    expect(report.projectClosure).toEqual({
      changedProjects: ["core"],
      unownedChangedPaths: [],
      closureProjects: ["api", "core", "web"],
      closureTaskIds: [
        "api:lint",
        "api:test",
        "api:typecheck",
        "core:lint",
        "core:test",
        "core:typecheck",
        "web:lint",
        "web:test",
        "web:typecheck",
      ],
      closureTaskCount: 9,
      selectedTaskCount: 3,
      reductionRatio: 3 / 9,
    });
  });

  it("closes the project set to just the changed project when nothing fallback-depends on it", () => {
    const plan: TestingPlanResult = {
      schemaVersion: 1,
      scope: {
        kind: "working-tree",
        changedPaths: ["apps/api/src/direct.ts"],
        fullFallback: false,
      },
      tasks: [task("api:typecheck"), task("api:test")],
      issues: [],
      complete: true,
      counts: { run: 2, skipProvenUnaffected: 0 },
    };

    const report = buildTestingReport({ plan, manifest });

    expect(report.projectClosure).toEqual({
      changedProjects: ["api"],
      unownedChangedPaths: [],
      closureProjects: ["api"],
      closureTaskIds: ["api:lint", "api:test", "api:typecheck"],
      closureTaskCount: 3,
      selectedTaskCount: 2,
      reductionRatio: 2 / 3,
    });
  });

  it("widens the project closure to every project when a changed path is unowned", () => {
    const plan: TestingPlanResult = {
      schemaVersion: 1,
      scope: {
        kind: "working-tree",
        changedPaths: ["docs/readme.md"],
        fullFallback: false,
      },
      tasks: allTaskIds.map((id) => task(id)),
      issues: [],
      complete: true,
      counts: { run: 9, skipProvenUnaffected: 0 },
    };

    const report = buildTestingReport({ plan, manifest });

    expect(report.projectClosure.changedProjects).toEqual([]);
    expect(report.projectClosure.unownedChangedPaths).toEqual([
      "docs/readme.md",
    ]);
    expect(report.projectClosure.closureProjects).toEqual([
      "api",
      "core",
      "web",
    ]);
    expect(report.projectClosure.closureTaskIds).toEqual(
      [...allTaskIds].sort(),
    );
    expect(report.projectClosure.closureTaskCount).toBe(9);
  });

  it("widens the project closure to every project for a full-fallback --all plan with no changed paths", () => {
    const plan: TestingPlanResult = {
      schemaVersion: 1,
      scope: { kind: "all", changedPaths: [], fullFallback: true },
      tasks: allTaskIds.map((id) =>
        task(id, { reason: "full-fallback", widened: true }),
      ),
      issues: [],
      complete: true,
      counts: { run: 9, skipProvenUnaffected: 0 },
    };

    const report = buildTestingReport({ plan, manifest });

    expect(report.projectClosure.changedProjects).toEqual([]);
    expect(report.projectClosure.unownedChangedPaths).toEqual([]);
    expect(report.projectClosure.closureProjects).toEqual([
      "api",
      "core",
      "web",
    ]);
    expect(report.projectClosure.closureTaskIds).toEqual(
      [...allTaskIds].sort(),
    );
    expect(report.projectClosure.closureTaskCount).toBe(9);
    expect(report.projectClosure.reductionRatio).toBe(1);
  });

  it("counts issues by code and by severity, deriving an undeclared severity from the code", () => {
    const issues: TestingPlanIssue[] = [
      {
        code: "unresolved-import",
        message: "The import could not be resolved.",
        severity: "error",
        scope: "module",
        path: "apps/api/src/handler.ts",
        line: 4,
        column: 10,
      },
      {
        code: "graph-missing",
        message: "The dependency graph was unavailable.",
      },
      { code: "unresolved-import", message: "Another unresolved import." },
    ];
    const plan: TestingPlanResult = {
      schemaVersion: 1,
      scope: { kind: "working-tree", changedPaths: [], fullFallback: false },
      tasks: [],
      issues,
      complete: true,
      counts: { run: 0, skipProvenUnaffected: 0 },
    };

    const report = buildTestingReport({ plan, manifest });

    expect(report.fallback.issuesByCode).toEqual({
      "unresolved-import": 2,
      "graph-missing": 1,
    });
    expect(report.fallback.issuesBySeverity).toEqual({
      info: 1,
      uncertainty: 1,
      error: 1,
    });
    expect(report.fallback.widening).toEqual([
      {
        code: "unresolved-import",
        message: "The import could not be resolved.",
        severity: "error",
        location: "apps/api/src/handler.ts:4:10",
        path: "apps/api/src/handler.ts",
        line: 4,
        column: 10,
      },
      {
        code: "unresolved-import",
        message: "Another unresolved import.",
        severity: "uncertainty",
      },
    ]);
  });

  it("reports forcedBy only when the plan fell back to the full workspace", () => {
    const issues: TestingPlanIssue[] = [
      {
        code: "unknown-changed-path",
        message: "A changed path could not be attributed to any module.",
        scope: "workspace",
      },
    ];
    const scope = {
      kind: "working-tree" as const,
      changedPaths: ["unknown/path.ts"],
    };
    const planWithoutFallback: TestingPlanResult = {
      schemaVersion: 1,
      scope: { ...scope, fullFallback: false },
      tasks: [],
      issues,
      complete: true,
      counts: { run: 0, skipProvenUnaffected: 0 },
    };
    const planWithFallback: TestingPlanResult = {
      ...planWithoutFallback,
      scope: { ...scope, fullFallback: true },
    };

    expect(
      buildTestingReport({ plan: planWithoutFallback, manifest }).fallback
        .forcedBy,
    ).toEqual([]);
    expect(
      buildTestingReport({ plan: planWithFallback, manifest }).fallback
        .forcedBy,
    ).toEqual([
      {
        code: "unknown-changed-path",
        message: "A changed path could not be attributed to any module.",
        severity: "uncertainty",
      },
    ]);
  });

  it("merges run status, exit code, and duration into execution totals and receipts", () => {
    const plan: TestingPlanResult = {
      schemaVersion: 1,
      scope: {
        kind: "working-tree",
        changedPaths: ["apps/api/src/direct.ts"],
        fullFallback: false,
      },
      tasks: [
        task("api:typecheck"),
        task("api:test"),
        task("core:test", {
          decision: "skip-proven-unaffected",
          reason: "no-reachable-change",
        }),
      ],
      issues: [],
      complete: true,
      counts: { run: 2, skipProvenUnaffected: 1 },
    };
    const run: TestingRunResult = {
      tasks: [
        {
          id: "api:typecheck",
          status: "executed",
          exitCode: 0,
          durationMs: 120,
        },
        { id: "api:test", status: "failed", exitCode: 1, durationMs: 340 },
      ],
      counts: { executed: 1, failed: 1, blocked: 0, notApplicable: 0 },
      exitCode: 1,
    };

    const report = buildTestingReport({ plan, manifest, run });

    expect(report.execution).toEqual({
      tasks: [
        {
          id: "api:typecheck",
          status: "executed",
          exitCode: 0,
          durationMs: 120,
        },
        { id: "api:test", status: "failed", exitCode: 1, durationMs: 340 },
      ],
      counts: { executed: 1, failed: 1, blocked: 0, notApplicable: 0 },
      exitCode: 1,
      totalTaskDurationMs: 460,
      wallClockMs: null,
    });
    expect(report.receipts).toEqual([
      {
        taskId: "api:typecheck",
        decision: "run",
        reason: "changed-path",
        status: "executed",
        exitCode: 0,
        durationMs: 120,
      },
      {
        taskId: "api:test",
        decision: "run",
        reason: "changed-path",
        status: "failed",
        exitCode: 1,
        durationMs: 340,
      },
      {
        taskId: "core:test",
        decision: "skip-proven-unaffected",
        reason: "no-reachable-change",
        status: "skipped",
      },
    ]);
  });

  it("reports no execution and planned/skipped receipts when no run happened", () => {
    const plan: TestingPlanResult = {
      schemaVersion: 1,
      scope: {
        kind: "working-tree",
        changedPaths: ["apps/api/src/direct.ts"],
        fullFallback: false,
      },
      tasks: [
        task("api:typecheck"),
        task("core:test", {
          decision: "skip-proven-unaffected",
          reason: "no-reachable-change",
        }),
      ],
      issues: [],
      complete: true,
      counts: { run: 1, skipProvenUnaffected: 1 },
    };

    const report = buildTestingReport({ plan, manifest });

    expect(report.execution).toBeNull();
    expect(report.receipts).toEqual([
      {
        taskId: "api:typecheck",
        decision: "run",
        reason: "changed-path",
        status: "planned",
      },
      {
        taskId: "core:test",
        decision: "skip-proven-unaffected",
        reason: "no-reachable-change",
        status: "skipped",
      },
    ]);
  });

  it("reports no reduction ratio when the project closure declares no tasks at all", () => {
    const closureWithoutTasks = parseTestingManifest(
      JSON.stringify({
        schemaVersion: 1,
        workspace: { root: ".", fullFallback: { taskIds: ["core:test"] } },
        projects: [
          { id: "core", root: "packages/core", fallbackDependencies: [] },
          { id: "tools", root: "tools", fallbackDependencies: [] },
        ],
        tasks: [
          {
            id: "core:test",
            project: "core",
            kind: "test",
            execution: { executable: "node", args: ["--test"] },
            dependsOn: [],
            impact: { mode: "project", paths: [] },
          },
        ],
      }),
      "closure-without-tasks.json",
    );
    const plan: TestingPlanResult = {
      schemaVersion: 1,
      scope: {
        kind: "working-tree",
        changedPaths: ["tools/build.mjs"],
        fullFallback: false,
      },
      tasks: [],
      issues: [],
      complete: true,
      counts: { run: 0, skipProvenUnaffected: 0 },
    };

    const report = buildTestingReport({ plan, manifest: closureWithoutTasks });

    expect(report.projectClosure.closureProjects).toEqual(["tools"]);
    expect(report.projectClosure.closureTaskIds).toEqual([]);
    expect(report.projectClosure.closureTaskCount).toBe(0);
    expect(report.projectClosure.reductionRatio).toBeNull();
  });
});

/** A task decision with test-friendly defaults, overridable per field. */
function task(
  id: string,
  overrides: Partial<Omit<TestingTaskDecision, "id">> = {},
): TestingTaskDecision {
  return {
    id,
    decision: "run",
    reason: "changed-path",
    confidence: "proven",
    widened: false,
    ...overrides,
  };
}
