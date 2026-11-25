import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDadTestCli, type DadTestCliIo } from "../dad-test-cli.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("dad-test run --verify-shadow", () => {
  it("runs skipped tasks in an uncached shadow pass and emits a clean trust receipt", async () => {
    const { directory, binary, readRequests } = createSequencedNativeBinary([
      {
        schemaVersion: 1,
        ok: true,
        result: {
          operation: "run",
          plan: {
            schemaVersion: 1,
            scope: { kind: "base-to-working-tree", changedPaths: ["packages/a/src/x.ts"], fullFallback: false },
            tasks: [
              { id: "a:test", decision: "run", reason: "changed-owned-project", confidence: "proven", widened: false },
              {
                id: "b:test",
                decision: "skip-proven-unaffected",
                reason: "proven-unaffected",
                confidence: "proven",
                widened: false,
              },
              {
                id: "c:test",
                decision: "skip-proven-unaffected",
                reason: "proven-unaffected",
                confidence: "proven",
                widened: false,
              },
            ],
            issues: [],
            complete: true,
            counts: { run: 1, skipProvenUnaffected: 2 },
          },
          run: {
            schemaVersion: 1,
            ok: true,
            exitCode: 0,
            tasks: [{ id: "a:test", status: "executed", exitCode: 0, durationMs: 10 }],
            counts: { executed: 1, failed: 0, blocked: 0, cached: 0 },
          },
        },
      },
      {
        schemaVersion: 1,
        ok: true,
        result: {
          operation: "run",
          plan: {
            schemaVersion: 1,
            scope: { kind: "explicit", changedPaths: [], fullFallback: false },
            tasks: [
              { id: "b:test", decision: "run", reason: "direct-task-input", confidence: "proven", widened: false },
              { id: "c:test", decision: "run", reason: "direct-task-input", confidence: "proven", widened: false },
            ],
            issues: [],
            complete: true,
            counts: { run: 2, skipProvenUnaffected: 0 },
          },
          run: {
            schemaVersion: 1,
            ok: true,
            exitCode: 0,
            tasks: [
              { id: "b:test", status: "executed", exitCode: 0, durationMs: 5 },
              { id: "c:test", status: "executed", exitCode: 0, durationMs: 6 },
            ],
            counts: { executed: 2, failed: 0, blocked: 0, cached: 0 },
          },
        },
      },
    ]);
    const harness = createHarness(directory, binary);

    const exitCode = await runDadTestCli(["run", "--cache", "--verify-shadow", "--json"], harness.io);

    expect(exitCode).toBe(0);
    const envelope: unknown = JSON.parse(harness.stdout());
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      ok: true,
      result: {
        shadowVerification: {
          skipped: 2,
          verifiedSkipped: 2,
          escapedFailures: [],
          undeclaredReads: [],
          reductionRatio: 0.6667,
          strict: false,
        },
      },
    });
    const requests = readRequests();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      operation: "run",
      only: true,
      all: false,
      taskIds: ["b:test", "c:test"],
    });
    expect(requests[1]).not.toHaveProperty("cache", true);
  });

  it("reports escaped failures non-blocking by default and exits 1 with --fail-on-shadow-escape", async () => {
    const primaryResponse = {
      schemaVersion: 1,
      ok: true,
      result: {
        operation: "run",
        plan: {
          schemaVersion: 1,
          scope: { kind: "base-to-working-tree", changedPaths: ["packages/a/src/x.ts"], fullFallback: false },
          tasks: [
            { id: "a:test", decision: "run", reason: "changed-owned-project", confidence: "proven", widened: false },
            {
              id: "b:test",
              decision: "skip-proven-unaffected",
              reason: "proven-unaffected",
              confidence: "proven",
              widened: false,
            },
          ],
          issues: [],
          complete: true,
          counts: { run: 1, skipProvenUnaffected: 1 },
        },
        run: {
          schemaVersion: 1,
          ok: true,
          exitCode: 0,
          tasks: [{ id: "a:test", status: "executed", exitCode: 0, durationMs: 10 }],
          counts: { executed: 1, failed: 0, blocked: 0, cached: 0 },
        },
      },
    };
    const shadowFailureResponse = {
      schemaVersion: 1,
      ok: true,
      result: {
        operation: "run",
        plan: {
          schemaVersion: 1,
          scope: { kind: "explicit", changedPaths: [], fullFallback: false },
          tasks: [{ id: "b:test", decision: "run", reason: "direct-task-input", confidence: "proven", widened: false }],
          issues: [],
          complete: true,
          counts: { run: 1, skipProvenUnaffected: 0 },
        },
        run: {
          schemaVersion: 1,
          ok: false,
          exitCode: 1,
          tasks: [
            {
              id: "b:test",
              status: "failed",
              exitCode: 1,
              durationMs: 7,
              undeclaredReads: [{ path: "settings/hidden.json", location: "packages/b/test.ts:4" }],
            },
          ],
          counts: { executed: 0, failed: 1, blocked: 0, cached: 0 },
        },
      },
    };

    const nonStrict = createSequencedNativeBinary([primaryResponse, shadowFailureResponse]);
    const h1 = createHarness(nonStrict.directory, nonStrict.binary);
    const nonStrictExit = await runDadTestCli(["run", "--verify-shadow"], h1.io);
    expect(nonStrictExit).toBe(0);
    expect(h1.stdout()).toContain("shadow-verify: 0/1 skipped tasks passed, 1 escaped failures, 1 undeclared reads");
    expect(h1.stdout()).toContain("ESCAPE b:test");
    expect(h1.stdout()).toContain("UNDECLARED b:test: settings/hidden.json");

    const strict = createSequencedNativeBinary([primaryResponse, shadowFailureResponse]);
    const h2 = createHarness(strict.directory, strict.binary);
    const strictExit = await runDadTestCli(["run", "--verify-shadow", "--fail-on-shadow-escape", "--json"], h2.io);
    expect(strictExit).toBe(1);
    const envelope: unknown = JSON.parse(h2.stdout());
    expect(envelope).toMatchObject({
      result: {
        shadowVerification: {
          skipped: 1,
          verifiedSkipped: 0,
          escapedFailures: [{ taskId: "b:test", status: "failed", exitCode: 1 }],
          undeclaredReads: [{ taskId: "b:test", path: "settings/hidden.json", location: "packages/b/test.ts:4" }],
          strict: true,
        },
      },
    });
  });

  it("rejects --fail-on-shadow-escape without --verify-shadow", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dads-shadow-err-"));
    temporaryDirectories.push(directory);
    const harness = createHarness(directory, "/nonexistent");

    const exitCode = await runDadTestCli(["run", "--fail-on-shadow-escape"], harness.io);

    expect(exitCode).toBe(1);
    expect(harness.stderr()).toContain("--fail-on-shadow-escape requires --verify-shadow");
  });
});

function createSequencedNativeBinary(responses: readonly unknown[]): {
  readonly directory: string;
  readonly binary: string;
  readonly readRequests: () => unknown[];
} {
  const directory = mkdtempSync(join(tmpdir(), "dads-shadow-test-"));
  temporaryDirectories.push(directory);
  const responsesFile = join(directory, "responses.json");
  const counterFile = join(directory, "counter.txt");
  const requestsFile = join(directory, "requests.jsonl");
  const binary = join(directory, "fake-dad-test.mjs");

  writeFileSync(responsesFile, JSON.stringify(responses), "utf8");
  writeFileSync(counterFile, "0", "utf8");
  writeFileSync(
    binary,
    `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const input = readFileSync(0, "utf8");
appendFileSync(${JSON.stringify(requestsFile)}, input.trim() + "\\n", "utf8");
const idx = Number.parseInt(readFileSync(${JSON.stringify(counterFile)}, "utf8"), 10);
writeFileSync(${JSON.stringify(counterFile)}, String(idx + 1), "utf8");
const list = JSON.parse(readFileSync(${JSON.stringify(responsesFile)}, "utf8"));
process.stdout.write(JSON.stringify(list[idx]) + "\\n");
`,
    { mode: 0o755 },
  );

  return {
    directory,
    binary,
    readRequests: () =>
      readFileSync(requestsFile, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line): unknown => JSON.parse(line)),
  };
}

function createHarness(
  cwd: string,
  nativeBinary: string,
): {
  readonly io: DadTestCliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      cwd,
      env: {},
      stdout: (text) => {
        out.push(text);
      },
      stderr: (text) => {
        err.push(text);
      },
      nativeBinary,
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}
