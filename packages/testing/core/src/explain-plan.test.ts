import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { explainPlan, renderPlanExplanation, type ExplainedTask, type PlanExplanation } from "./explain-plan.js";
import type { TestingPlanResult } from "./testing-api.js";
import { readTestingManifest } from "./testing-manifest.js";

const repositoryRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");

const soundnessManifest = readTestingManifest(
  repositoryRoot,
  join("fixtures", "testing-soundness", "dads.testing.json"),
);

/** A plan from an engine that reports causes: every cause is proven. */
const enginePlan: TestingPlanResult = {
  schemaVersion: 1,
  scope: {
    kind: "base-to-working-tree",
    base: "a1b2c3d",
    head: "e4f5a6b",
    changedPaths: ["apps/web/src/load.ts", "packages/core/src/leaf.ts", "docs/notes.md"],
    fullFallback: false,
  },
  tasks: [
    {
      id: "web:test",
      project: "web",
      decision: "run",
      reason: "graph-uncertainty-project-fallback",
      confidence: "conservative",
      widened: true,
      causes: [
        { kind: "issue", index: 0 },
        { kind: "fallback-dependency", project: "core" },
      ],
    },
    {
      id: "api:test",
      project: "api",
      decision: "run",
      reason: "graph-symbol-importer",
      confidence: "proven",
      widened: false,
      causes: [
        {
          kind: "changed-export",
          path: "packages/core/src/leaf.ts",
          symbol: "renderPage",
        },
        {
          kind: "reached-import",
          path: "apps/api/src/server.ts",
          line: 4,
          column: 1,
          importedFrom: "packages/core/src/leaf.ts",
          symbols: ["renderPage", "helper"],
        },
      ],
    },
    {
      id: "core:test",
      project: "core",
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
      message: "nonliteral dynamic import cannot be resolved",
      severity: "uncertainty",
      scope: "module",
      path: "apps/web/src/load.ts",
      line: 12,
      column: 5,
      project: "web",
    },
    {
      code: "graph-snapshot-reused",
      message: "reused the persisted graph snapshot",
    },
  ],
  complete: true,
  counts: { run: 2, skipProvenUnaffected: 1 },
};

/** A plan from an engine older than this facade: reasons, and nothing else. */
const legacyPlan: TestingPlanResult = {
  schemaVersion: 1,
  scope: {
    kind: "base-to-head",
    changedPaths: ["packages/core/src/leaf.ts"],
    fullFallback: false,
  },
  tasks: [
    {
      id: "core:typecheck",
      decision: "run",
      reason: "selected-prerequisite",
      confidence: "conservative",
      widened: false,
    },
    {
      id: "core:test",
      decision: "run",
      reason: "changed-owned-project",
      confidence: "proven",
      widened: false,
    },
    {
      id: "web:test",
      decision: "run",
      reason: "graph-symbol-importer",
      confidence: "proven",
      widened: false,
    },
    {
      id: "api:test",
      decision: "skip-proven-unaffected",
      reason: "proven-unaffected",
      confidence: "proven",
      widened: false,
    },
  ],
  issues: [
    {
      code: "graph-snapshot-reused",
      message: "reused the persisted graph snapshot",
    },
  ],
  complete: true,
  counts: { run: 3, skipProvenUnaffected: 1 },
};

describe("explainPlan with engine causes", () => {
  it("reports engine detail and maps every cause the engine proved", () => {
    const explanation = explainPlan(enginePlan, soundnessManifest);

    expect(explanation.detail).toBe("engine");
    expect(explanation.summary).toEqual({
      tasks: 3,
      selected: 2,
      skipped: 1,
      widened: 1,
      byReason: {
        "graph-uncertainty-project-fallback": 1,
        "graph-symbol-importer": 1,
        "proven-unaffected": 1,
      },
      fullFallback: false,
      fullFallbackCauses: [],
    });
    expect(taskById(explanation, "web:test").causes).toEqual([
      {
        kind: "issue",
        issue: {
          code: "nonliteral-dynamic-import",
          message: "nonliteral dynamic import cannot be resolved",
          location: "apps/web/src/load.ts:12:5",
          severity: "uncertainty",
          scope: "module",
          project: "web",
        },
      },
      { kind: "fallback-dependency", project: "core" },
    ]);
    expect(taskById(explanation, "api:test").causes).toEqual([
      {
        kind: "changed-export",
        path: "packages/core/src/leaf.ts",
        symbol: "renderPage",
      },
      {
        kind: "reached-import",
        path: "apps/api/src/server.ts",
        location: "apps/api/src/server.ts:4:1",
        importedFrom: "packages/core/src/leaf.ts",
        symbols: ["renderPage", "helper"],
      },
    ]);
  });

  it("counts an empty cause list as reported rather than missing", () => {
    expect(explainPlan(enginePlan).detail).toBe("engine");
    expect(taskById(explainPlan(enginePlan), "core:test").causes).toEqual([]);
  });

  it("reports an issue reference the plan cannot satisfy instead of failing", () => {
    const explanation = explainPlan({
      ...enginePlan,
      tasks: [
        {
          id: "web:test",
          decision: "run",
          reason: "full-fallback",
          confidence: "conservative",
          widened: true,
          causes: [{ kind: "issue", index: 9 }],
        },
      ],
    });

    const [cause] = taskById(explanation, "web:test").causes;
    expect(cause).toEqual({
      kind: "issue",
      issue: {
        code: "unknown-issue-index",
        message: "the plan referenced issue index 9, which it does not contain",
        severity: "uncertainty",
        scope: "unknown",
      },
    });
    expect(explanation.summary.fullFallbackCauses).toEqual([expect.objectContaining({ code: "unknown-issue-index" })]);
  });

  it("renders the engine explanation as stable anchored lines", () => {
    expect(renderPlanExplanation(explainPlan(enginePlan))).toBe(
      [
        "explain: 2 of 3 tasks selected, 1 skipped, 1 widened detail=engine",
        "scope: kind=base-to-working-tree base=a1b2c3d head=e4f5a6b changed=3",
        "full-fallback: no",
        "RUN web:test project=web reason=graph-uncertainty-project-fallback confidence=conservative widened=yes",
        "  because graph proof incomplete; widened through fallback dependencies",
        "  issue nonliteral-dynamic-import apps/web/src/load.ts:12:5 nonliteral dynamic import cannot be resolved",
        "  fallback-dependency core",
        "RUN api:test project=api reason=graph-symbol-importer confidence=proven widened=no",
        "  because imports a changed symbol",
        "  export renderPage packages/core/src/leaf.ts",
        "  import apps/api/src/server.ts:4:1 from packages/core/src/leaf.ts renderPage,helper",
        "SKIP core:test project=core reason=proven-unaffected confidence=proven widened=no",
        "  because no changed path or symbol reaches this task",
        "info graph-snapshot-reused reused the persisted graph snapshot",
        "",
      ].join("\n"),
    );
  });
});

describe("explainPlan without engine causes", () => {
  it("derives project, prerequisites and owned changed paths from the manifest", () => {
    const explanation = explainPlan(legacyPlan, soundnessManifest);

    expect(explanation.detail).toBe("derived");
    expect(taskById(explanation, "core:typecheck").project).toBe("core");
    expect(taskById(explanation, "core:typecheck").causes).toEqual([{ kind: "prerequisite-of", taskId: "core:test" }]);
    expect(taskById(explanation, "core:test").causes).toEqual([
      { kind: "changed-path", path: "packages/core/src/leaf.ts" },
    ]);
    expect(taskById(explanation, "api:test").causes).toEqual([]);
  });

  it("says when a reason carries detail this build cannot reconstruct", () => {
    const explanation = explainPlan(legacyPlan, soundnessManifest);

    const importer = taskById(explanation, "web:test");
    expect(importer.causes).toEqual([]);
    expect(importer.reasonText).toBe("imports a changed symbol (symbol not reported by this dad-test build)");
  });

  it("reports no project and no ownership causes without a manifest", () => {
    const explanation = explainPlan(legacyPlan);

    expect(taskById(explanation, "core:test").project).toBeUndefined();
    expect(taskById(explanation, "core:test").causes).toEqual([]);
    expect(taskById(explanation, "core:typecheck").causes).toEqual([]);
  });

  it("blames the workspace uncertainty that forced the full fallback", () => {
    const explanation = explainPlan(
      {
        schemaVersion: 1,
        scope: {
          kind: "base-to-head",
          changedPaths: ["tools/generate.sh"],
          fullFallback: true,
        },
        tasks: [
          {
            id: "core:test",
            decision: "run",
            reason: "full-fallback",
            confidence: "conservative",
            widened: true,
          },
        ],
        issues: [
          {
            code: "unknown-changed-path",
            message: "tools/generate.sh is not owned by any project",
          },
        ],
        complete: false,
        counts: { run: 1, skipProvenUnaffected: 0 },
      },
      soundnessManifest,
    );

    const forcedBy = {
      code: "unknown-changed-path",
      message: "tools/generate.sh is not owned by any project",
      severity: "uncertainty",
      scope: "workspace",
    };
    expect(explanation.summary.fullFallbackCauses).toEqual([forcedBy]);
    expect(taskById(explanation, "core:test").causes).toEqual([{ kind: "issue", issue: forcedBy }]);
    expect(renderPlanExplanation(explanation)).toContain(
      "full-fallback: yes\n  forced-by unknown-changed-path tools/generate.sh is not owned by any project\n",
    );
  });

  it("keeps a module uncertainty about another project out of this one", () => {
    const explanation = explainPlan(
      {
        schemaVersion: 1,
        scope: {
          kind: "base-to-head",
          changedPaths: ["apps/web/src/view.ts", "packages/core/src/leaf.ts"],
          fullFallback: false,
        },
        tasks: [
          {
            id: "web:test",
            decision: "run",
            reason: "graph-uncertainty-project-fallback",
            confidence: "conservative",
            widened: true,
          },
        ],
        issues: [
          {
            code: "unresolved-import",
            message: "a web import is unresolved",
            project: "web",
          },
          {
            code: "unresolved-import",
            message: "a core import is unresolved",
            project: "core",
          },
          {
            code: "nonliteral-dynamic-import",
            message: "a dynamic import is unresolved",
          },
        ],
        complete: false,
        counts: { run: 1, skipProvenUnaffected: 0 },
      },
      soundnessManifest,
    );

    expect(taskById(explanation, "web:test").causes).toEqual([
      {
        kind: "issue",
        issue: {
          code: "unresolved-import",
          message: "a web import is unresolved",
          severity: "uncertainty",
          scope: "module",
          project: "web",
        },
      },
      {
        kind: "issue",
        issue: {
          code: "nonliteral-dynamic-import",
          message: "a dynamic import is unresolved",
          severity: "uncertainty",
          scope: "module",
        },
      },
      { kind: "changed-path", path: "apps/web/src/view.ts" },
    ]);
  });

  it("renders the derived explanation as stable anchored lines", () => {
    expect(renderPlanExplanation(explainPlan(legacyPlan, soundnessManifest))).toBe(
      [
        "explain: 3 of 4 tasks selected, 1 skipped, 0 widened detail=derived",
        "scope: kind=base-to-head changed=1",
        "full-fallback: no",
        "RUN core:typecheck project=core reason=selected-prerequisite confidence=conservative widened=no",
        "  because prerequisite of a selected task",
        "  prerequisite-of core:test",
        "RUN core:test project=core reason=changed-owned-project confidence=proven widened=no",
        "  because a changed path is owned by this project",
        "  changed packages/core/src/leaf.ts",
        "RUN web:test project=web reason=graph-symbol-importer confidence=proven widened=no",
        "  because imports a changed symbol (symbol not reported by this dad-test build)",
        "SKIP api:test project=api reason=proven-unaffected confidence=proven widened=no",
        "  because no changed path or symbol reaches this task",
        "info graph-snapshot-reused reused the persisted graph snapshot",
        "",
      ].join("\n"),
    );
  });
});

describe("informational issues", () => {
  it("reports an informational issue as context and never as a cause", () => {
    const explanation = explainPlan(enginePlan, soundnessManifest);

    expect(explanation.informational).toEqual([
      {
        code: "graph-snapshot-reused",
        message: "reused the persisted graph snapshot",
        severity: "info",
        scope: "unknown",
      },
    ]);
    const causedByCode = explanation.tasks
      .flatMap((task) => task.causes)
      .filter((cause) => cause.kind === "issue")
      .map((cause) => cause.issue.code);
    expect(causedByCode).not.toContain("graph-snapshot-reused");
  });
});

function taskById(explanation: PlanExplanation, id: string): ExplainedTask {
  const task = explanation.tasks.find((candidate) => candidate.id === id);
  if (task === undefined) throw new Error(`No explained task ${id}.`);
  return task;
}
