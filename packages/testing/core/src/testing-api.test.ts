import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeNativeBinary } from "./test-support/native-fixture.js";
import { planTesting, runTesting } from "./testing-api.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Dads Testing native facade", () => {
  it("sends one versioned plan request to an explicit native binary", async () => {
    const fixture = createOlderEngineFixture("plan");

    const plan = await planTesting({
      workspaceRoot: fixture.directory,
      nativeBinary: fixture.binary,
    });

    expect(plan.tasks[0]?.decision).toBe("run");
    expect(plan.tasks[0]?.widened).toBe(true);
    expect(plan.tasks[0]?.project).toBeUndefined();
    expect(plan.tasks[0]?.causes).toBeUndefined();
  });

  it("returns the native run plan and execution statuses", async () => {
    const fixture = createOlderEngineFixture("run");

    const result = await runTesting({
      workspaceRoot: fixture.directory,
      all: true,
      nativeBinary: fixture.binary,
    });

    expect(result.run.tasks[0]?.status).toBe("executed");
    expect(result.run.tasks[0]?.durationMs).toBe(7);
    expect(result.run.tasks[0]?.stdout).toEqual({
      text: "passed\n",
      truncated: false,
    });
    expect(result.run.exitCode).toBe(0);
  });

  it("reads task ownership, causes, and located issues from a newer engine", async () => {
    const directory = makeTemporaryDirectory();
    const fixture = createFakeNativeBinary(directory, {
      schemaVersion: 1,
      ok: true,
      result: {
        operation: "plan",
        plan: {
          schemaVersion: 1,
          scope: {
            kind: "working-tree",
            changedPaths: ["packages/core/src/index.ts"],
            fullFallback: false,
          },
          tasks: [
            {
              id: "api:test",
              decision: "run",
              reason: "reached-import",
              confidence: "proven",
              widened: false,
              project: "api",
              causes: [
                { kind: "changed-path", path: "packages/core/src/index.ts" },
                {
                  kind: "reached-import",
                  path: "apps/api/src/handler.ts",
                  line: 4,
                  column: 10,
                  importedFrom: "packages/core/src/index.ts",
                  symbols: ["createHandler"],
                },
                { kind: "issue", index: 0 },
              ],
            },
          ],
          issues: [
            {
              code: "unresolved-import",
              message: "The import target could not be resolved.",
              severity: "uncertainty",
              scope: "module",
              path: "apps/api/src/handler.ts",
              line: 4,
              column: 10,
              project: "api",
            },
          ],
          complete: true,
          counts: { run: 1, skipProvenUnaffected: 0 },
        },
      },
    });

    const plan = await planTesting({
      workspaceRoot: directory,
      nativeBinary: fixture.binary,
    });

    expect(plan.tasks[0]?.project).toBe("api");
    expect(plan.tasks[0]?.causes?.[1]).toEqual({
      kind: "reached-import",
      path: "apps/api/src/handler.ts",
      line: 4,
      column: 10,
      importedFrom: "packages/core/src/index.ts",
      symbols: ["createHandler"],
    });
    expect(plan.issues[0]?.path).toBe("apps/api/src/handler.ts");
    expect(plan.issues[0]?.severity).toBe("uncertainty");
    const issueCause = plan.tasks[0]?.causes?.[2];
    expect(issueCause?.kind === "issue" ? issueCause.index : undefined).toBe(0);
  });
});

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dads-testing-native-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** The minimal response an engine without task causes or issue locations sends. */
function createOlderEngineFixture(operation: "plan" | "run"): {
  readonly directory: string;
  readonly binary: string;
} {
  const directory = makeTemporaryDirectory();
  const { binary } = createFakeNativeBinary(directory, {
    schemaVersion: 1,
    ok: true,
    result: {
      operation,
      plan: {
        schemaVersion: 1,
        scope: { kind: "all", changedPaths: [], fullFallback: true },
        tasks: [
          {
            id: "fixture:test",
            decision: "run",
            reason: "full-fallback",
            confidence: "conservative",
            widened: true,
          },
        ],
        issues: [],
        complete: true,
        counts: { run: 1, skipProvenUnaffected: 0 },
      },
      ...(operation === "run"
        ? {
            run: {
              tasks: [
                {
                  id: "fixture:test",
                  status: "executed",
                  exitCode: 0,
                  durationMs: 7,
                  stdout: { text: "passed\n", truncated: false },
                  stderr: { text: "", truncated: false },
                },
              ],
              counts: { executed: 1, failed: 0, blocked: 0, notApplicable: 0 },
              exitCode: 0,
            },
          }
        : {}),
    },
  });
  return { directory, binary };
}
