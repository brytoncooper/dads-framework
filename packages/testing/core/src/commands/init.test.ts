import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDadTestCli, type DadTestCliIo } from "../dad-test-cli.js";
import { createFakeNativeBinary } from "../test-support/native-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const planResponse = {
  schemaVersion: 1,
  ok: true,
  result: {
    operation: "plan",
    plan: {
      schemaVersion: 1,
      scope: { kind: "all", changedPaths: [], fullFallback: true },
      tasks: [],
      issues: [],
      complete: true,
      counts: { run: 3, skipProvenUnaffected: 0 },
    },
  },
};

describe("dad-test init", () => {
  it("writes the versioned envelope, then refuses to overwrite without --force", async () => {
    const workspaceRoot = makeWorkspace();
    const nativeBinary = createFakeNativeBinary(
      makeTemporaryDirectory(),
      planResponse,
    ).binary;

    const first = createHarness(workspaceRoot, nativeBinary);
    expect(await runDadTestCli(["init", "--json"], first.io)).toBe(0);
    expect(first.stderr()).toBe("");
    expect(readEnvelope(first.stdout())).toMatchObject({
      schemaVersion: 1,
      ok: true,
      result: {
        manifestPath: "dads.testing.json",
        reportPath: "dads.testing.init-report.json",
        report: { validation: { method: "native", selectedTaskCount: 3 } },
      },
    });

    const second = createHarness(workspaceRoot, nativeBinary);
    expect(await runDadTestCli(["init"], second.io)).toBe(1);
    expect(second.stdout()).toBe("");
    expect(second.stderr()).toBe(
      "dad-test: Refusing to overwrite existing dads.testing.json; pass --force to replace it.\n",
    );

    const third = createHarness(workspaceRoot, nativeBinary);
    expect(await runDadTestCli(["init", "--force"], third.io)).toBe(0);
    expect(third.stdout()).toBe(
      [
        "init: wrote dads.testing.json (2 projects, 3 tasks) validation=native selected=3",
        "report: dads.testing.init-report.json",
        "skipped packages/docs: no-recognized-scripts",
        "",
      ].join("\n"),
    );
  });

  it("rejects an option no command declares", async () => {
    const harness = createHarness(makeWorkspace());

    expect(await runDadTestCli(["init", "--wat"], harness.io)).toBe(1);
    expect(harness.stderr()).toBe("dad-test: Unknown option --wat.\n");
  });
});

function readEnvelope(text: string): unknown {
  return JSON.parse(text);
}

function makeWorkspace(): string {
  const directory = makeTemporaryDirectory();
  const files: Readonly<Record<string, string>> = {
    "package.json": JSON.stringify({
      name: "workspace",
      workspaces: ["packages/*"],
    }),
    "package-lock.json": "{}",
    "packages/core/package.json": JSON.stringify({
      name: "core",
      scripts: { test: "vitest run", typecheck: "tsc -b" },
    }),
    "packages/api/package.json": JSON.stringify({
      name: "api",
      scripts: { test: "vitest run" },
    }),
    "packages/docs/package.json": JSON.stringify({
      name: "docs",
      scripts: { start: "serve" },
    }),
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(directory, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
  return directory;
}

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dads-testing-init-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createHarness(
  cwd: string,
  nativeBinary?: string,
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
    ...(nativeBinary === undefined ? {} : { nativeBinary }),
  };
  return {
    io,
    stdout: () => stdoutChunks.join(""),
    stderr: () => stderrChunks.join(""),
  };
}
