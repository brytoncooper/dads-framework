import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDadTestCli, type DadTestCliIo } from "../dad-test-cli.js";
import { createFakeNativeBinary } from "../test-support/native-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const manifestDocument = {
  schemaVersion: 1,
  workspace: { root: ".", fullFallback: { taskIds: ["core:test"] } },
  projects: [{ id: "core", root: "packages/core", fallbackDependencies: [] }],
  tasks: [
    {
      id: "core:test",
      project: "core",
      kind: "test",
      execution: { executable: "true", args: [] },
      dependsOn: [],
      impact: { mode: "reachability", paths: [] },
    },
  ],
};

/** A plan from an engine that reports no causes, so the manifest must supply them. */
const legacyPlan = {
  schemaVersion: 1,
  scope: {
    kind: "base-to-working-tree",
    changedPaths: ["packages/core/src/leaf.ts"],
    fullFallback: false,
  },
  tasks: [
    {
      id: "core:test",
      decision: "run",
      reason: "changed-owned-project",
      confidence: "proven",
      widened: false,
    },
  ],
  issues: [],
  complete: true,
  counts: { run: 1, skipProvenUnaffected: 0 },
};

describe("dad-test explain", () => {
  it("writes the versioned envelope around the explanation", async () => {
    const workspace = makeWorkspace();
    const harness = createHarness(workspace.directory, workspace.nativeBinary);

    const exitCode = await runDadTestCli(["explain", "--all", "--json"], harness.io);

    expect(exitCode).toBe(0);
    expect(harness.stderr()).toBe("");
    const envelope: unknown = JSON.parse(harness.stdout());
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      ok: true,
      result: {
        schemaVersion: 1,
        detail: "derived",
        summary: { tasks: 1, selected: 1, skipped: 0, widened: 0 },
        tasks: [
          {
            id: "core:test",
            // The project comes from the manifest the command read.
            project: "core",
            decision: "run",
            reasonText: "a changed path is owned by this project",
            causes: [{ kind: "changed-path", path: "packages/core/src/leaf.ts" }],
          },
        ],
      },
    });
    expect(workspace.readRequest()).toMatchObject({
      operation: "plan",
      all: true,
      taskIds: [],
    });
  });

  it("writes only the rendered explanation without --json", async () => {
    const workspace = makeWorkspace();
    const harness = createHarness(workspace.directory, workspace.nativeBinary);

    const exitCode = await runDadTestCli(["explain", "--all"], harness.io);

    expect(exitCode).toBe(0);
    expect(harness.stdout().split("\n")[0]).toBe("explain: 1 of 1 tasks selected, 0 skipped, 0 widened detail=derived");
    expect(harness.stdout()).not.toContain("completed");
  });

  it("fails with the manifest error when the manifest is missing", async () => {
    const workspace = makeWorkspace({ writeManifest: false });
    const harness = createHarness(workspace.directory, workspace.nativeBinary);

    const exitCode = await runDadTestCli(["explain", "--all", "--json"], harness.io);

    expect(exitCode).toBe(1);
    expect(harness.stdout()).toBe("");
    expect(harness.stderr()).toContain("dads.testing.json");
    const envelope: unknown = JSON.parse(harness.stderr());
    expect(envelope).toMatchObject({ schemaVersion: 1, ok: false });
  });

  it("expands manifests that declare workspace.discover via the native engine", async () => {
    const workspace = makeDiscoverWorkspace();
    const harness = createHarness(workspace.directory, workspace.nativeBinary);

    const exitCode = await runDadTestCli(
      ["explain", "--base", "main", "--head", "HEAD", "--task", "core:test", "--json"],
      harness.io,
    );

    expect(exitCode).toBe(0);
    expect(harness.stderr()).toBe("");
    const envelope: unknown = JSON.parse(harness.stdout());
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      ok: true,
      result: {
        schemaVersion: 1,
        detail: "derived",
        summary: { tasks: 1, selected: 1, skipped: 0, widened: 0 },
        tasks: [
          {
            id: "core:test",
            project: "core",
            decision: "run",
            reasonText: "a changed path is owned by this project",
            causes: [{ kind: "changed-path", path: "packages/core/src/leaf.ts" }],
          },
        ],
      },
    });
    expect(workspace.readRequests()).toMatchObject([
      { operation: "plan", base: "main", head: "HEAD", taskIds: ["core:test"] },
      { operation: "expand-manifest" },
    ]);
  });

  it("forwards --manifest when expanding a declarative manifest", async () => {
    const workspace = makeDiscoverWorkspace("custom.testing.json");
    const harness = createHarness(workspace.directory, workspace.nativeBinary);

    const exitCode = await runDadTestCli(
      ["explain", "--manifest", "custom.testing.json", "--all", "--json"],
      harness.io,
    );

    expect(exitCode).toBe(0);
    expect(workspace.readRequests()).toMatchObject([
      { operation: "plan", manifestPath: "custom.testing.json", all: true },
      { operation: "expand-manifest", manifestPath: "custom.testing.json" },
    ]);
  });
});

function makeDiscoverWorkspace(manifestFileName = "dads.testing.json"): {
  readonly directory: string;
  readonly nativeBinary: string;
  readonly readRequests: () => readonly unknown[];
} {
  const directory = mkdtempSync(join(tmpdir(), "dads-testing-explain-discover-"));
  temporaryDirectories.push(directory);
  const declarativeManifest = {
    schemaVersion: 1,
    workspace: {
      root: ".",
      discover: {
        projectFiles: ["packages/*/package.json"],
      },
    },
  };
  writeFileSync(join(directory, manifestFileName), JSON.stringify(declarativeManifest), "utf8");
  const fixture = createDispatchingFakeNativeBinary(directory, {
    plan: {
      schemaVersion: 1,
      ok: true,
      result: { operation: "plan", plan: legacyPlan },
    },
    "expand-manifest": {
      schemaVersion: 1,
      ok: true,
      result: { operation: "expand-manifest", plan: legacyPlan, manifest: manifestDocument },
    },
  });
  return {
    directory,
    nativeBinary: fixture.binary,
    readRequests: fixture.readRequests,
  };
}

function createDispatchingFakeNativeBinary(
  directory: string,
  responsesByOperation: Readonly<Record<string, unknown>>,
): {
  readonly binary: string;
  readonly readRequests: () => readonly unknown[];
} {
  const binary = join(directory, "fake-dispatch-native-binary.mjs");
  const logPath = join(directory, "requests.ndjson");
  const source = [
    "#!/usr/bin/env node",
    'import { appendFileSync } from "node:fs";',
    `const responses = ${JSON.stringify(responsesByOperation)};`,
    'let raw = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { raw += chunk; });',
    'process.stdin.on("end", () => {',
    `  appendFileSync(${JSON.stringify(logPath)}, raw.trim() + "\\n", "utf8");`,
    "  const req = JSON.parse(raw);",
    "  const response = responses[req.operation];",
    '  process.stdout.write(JSON.stringify(response) + "\\n");',
    "});",
    "",
  ].join("\n");
  writeFileSync(binary, source, "utf8");
  chmodSync(binary, 0o755);
  return {
    binary,
    readRequests: (): readonly unknown[] =>
      readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line)),
  };
}

function makeWorkspace(options: { readonly writeManifest?: boolean } = {}): {
  readonly directory: string;
  readonly nativeBinary: string;
  readonly readRequest: () => unknown;
} {
  const directory = mkdtempSync(join(tmpdir(), "dads-testing-explain-"));
  temporaryDirectories.push(directory);
  if (options.writeManifest !== false) {
    writeFileSync(join(directory, "dads.testing.json"), JSON.stringify(manifestDocument), "utf8");
  }
  const fixture = createFakeNativeBinary(directory, {
    schemaVersion: 1,
    ok: true,
    result: { operation: "plan", plan: legacyPlan },
  });
  return {
    directory,
    nativeBinary: fixture.binary,
    readRequest: fixture.readRequest,
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
