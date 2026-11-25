import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDadTestCli, type DadTestCliIo } from "../dad-test-cli.js";
import {
  detectRootVitestConfig,
  detectSqlMigrationRoots,
  detectWorkspacePureFactories,
} from "../init/detect-pure-factories.js";
import { initDiscoverManifest } from "../init/discover-init.js";
import { isRecord } from "../parse-guards.js";
import { createFakeNativeBinary } from "../test-support/native-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const expandedResponse = {
  schemaVersion: 1,
  ok: true,
  result: {
    operation: "expand-manifest",
    plan: {
      schemaVersion: 1,
      scope: { kind: "expand-manifest", changedPaths: [], fullFallback: false },
      tasks: [],
      issues: [],
      complete: true,
      counts: { run: 0, skipProvenUnaffected: 0 },
    },
    manifest: {
      schemaVersion: 1,
      workspace: { root: ".", fullFallback: { taskIds: ["core:test", "core:typecheck", "web:test"] } },
      projects: [
        { id: "core", root: "packages/core", fallbackDependencies: [] },
        { id: "web", root: "packages/web", fallbackDependencies: [] },
      ],
      tasks: [
        {
          id: "core:test",
          project: "core",
          kind: "test",
          execution: { executable: "npx", args: ["vitest", "run"], cwd: "packages/core" },
          dependsOn: [],
          impact: { mode: "reachability", paths: [] },
        },
        {
          id: "core:typecheck",
          project: "core",
          kind: "typecheck",
          execution: { executable: "npm", args: ["run", "typecheck"], cwd: "packages/core" },
          dependsOn: [],
          impact: { mode: "reachability", paths: [] },
        },
        {
          id: "web:test",
          project: "web",
          kind: "test",
          execution: { executable: "npx", args: ["vitest", "run"], cwd: "packages/web" },
          dependsOn: [],
          impact: { mode: "reachability", paths: [] },
        },
      ],
    },
  },
};

describe("dad-test init --discover", () => {
  it("generates a compact workspace.discover manifest with auto-detected pureFactories, setupFiles, sql roots, and ignorePaths", async () => {
    const workspaceRoot = makeWorkspace({
      "package.json": JSON.stringify({
        name: "acme",
        workspaces: ["packages/*"],
        dependencies: { zod: "^4.0.0", react: "^19.0.0" },
        devDependencies: { vitest: "^4.0.0", "drizzle-orm": "^0.40.0" },
      }),
      "package-lock.json": "{}",
      "vitest.config.ts": `export default { test: { setupFiles: ["./test/setup-a.ts", './test/setup-b.ts'] } };\n`,
      "drizzle.config.ts": `export default { schema: "./src/schema.ts", out: "./db/drizzle" };\n`,
      "migrations/0001_init.sql": "CREATE TABLE users (id int);\n",
      "db/migrations/0002_posts.sql": "CREATE TABLE posts (id int);\n",
      "packages/core/package.json": JSON.stringify({
        name: "@acme/core",
        dependencies: { valibot: "^1.0.0", pinia: "^3.0.0" },
        scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
      }),
      "packages/web/package.json": JSON.stringify({
        name: "@acme/web",
        dependencies: { "class-variance-authority": "^0.7.0", zod: "^4.0.0" },
        scripts: { test: "vitest run" },
      }),
    });
    const fixture = createFakeNativeBinary(makeTemporaryDirectory(), expandedResponse);
    const harness = createHarness(workspaceRoot, fixture.binary);

    const exitCode = await runDadTestCli(["init", "--discover"], harness.io);

    expect(exitCode).toBe(0);
    expect(harness.stderr()).toBe("");
    const stdout = harness.stdout();
    expect(stdout).toContain("init --discover: wrote dads.testing.json (2 projects, 3 tasks) validation=native");
    expect(stdout).toContain(
      "pureFactories: React.forwardRef, React.memo, createContext, cva, defineStore, mysqlTable, pgTable, sqliteTable, v.*, z.*",
    );
    expect(stdout).toContain("ignorePaths: docs/**, .github/**, **/*.md");
    expect(stdout).toContain("setupFiles: test/setup-a.ts, test/setup-b.ts");
    expect(stdout).toContain("sql.migrationRoots: db/drizzle, db/migrations, migrations");
    expect(stdout).toContain("Run npx dad-test audit --fix to discover dynamic file reads.");

    const written = readJsonObject(join(workspaceRoot, "dads.testing.json"));
    expect(written).toMatchObject({
      schemaVersion: 1,
      workspace: {
        root: ".",
        ignorePaths: ["docs/**", ".github/**", "**/*.md"],
        pureFactories: [
          "React.forwardRef",
          "React.memo",
          "createContext",
          "cva",
          "defineStore",
          "mysqlTable",
          "pgTable",
          "sqliteTable",
          "v.*",
          "z.*",
        ],
        sql: { migrationRoots: ["db/drizzle", "db/migrations", "migrations"] },
        discover: {
          projectFiles: ["packages/*/package.json"],
          targetTemplates: [
            {
              target: "test",
              kind: "test",
              when: { hasTarget: "test" },
              autoVitestNarrowing: true,
              execution: {
                executable: "npx",
                args: ["vitest", "run"],
                cwd: "{projectRoot}",
                fileNarrowing: { setupFiles: ["test/setup-a.ts", "test/setup-b.ts"] },
              },
              impact: { mode: "reachability", paths: ["test/setup-a.ts", "test/setup-b.ts", "vitest.config.ts"] },
            },
            {
              target: "typecheck",
              kind: "typecheck",
              when: { hasTarget: "typecheck" },
              execution: { executable: "npm", args: ["run", "typecheck"], cwd: "{projectRoot}" },
            },
          ],
        },
      },
    });
    expect(fixture.readRequest()).toMatchObject({ operation: "expand-manifest", workspaceRoot });
    expect(temporaryFilesIn(workspaceRoot)).toEqual([]);
  });

  it("supports Nx project.json workspaces with --discover while keeping default init refusal intact", async () => {
    const workspaceRoot = makeWorkspace({
      "package.json": JSON.stringify({ name: "nx-mono", devDependencies: { vitest: "^4.0.0", zod: "^4.0.0" } }),
      "nx.json": "{}\n",
      "apps/web/project.json": JSON.stringify({ name: "web", targets: { test: {}, lint: {} } }),
      "libs/core/project.json": JSON.stringify({ name: "core", targets: { test: {}, typecheck: {} } }),
      "libs/domain/billing/project.json": JSON.stringify({ name: "billing", targets: { test: {} } }),
    });

    // Default `init` (without --discover) MUST still refuse Nx workspaces (INV-TESTING-21).
    const defaultHarness = createHarness(workspaceRoot);
    expect(await runDadTestCli(["init"], defaultHarness.io)).toBe(1);
    expect(defaultHarness.stderr()).toContain("cannot establish Nx target coverage");
    expect(existsSync(join(workspaceRoot, "dads.testing.json"))).toBe(false);

    // `init --discover` handles Nx project.json layouts cleanly.
    const result = await initDiscoverManifest({
      workspaceRoot,
      resolveNativeBinary: () => undefined,
    });
    expect(result.validation).toEqual({ method: "structural", ok: true, projectCount: 3, taskCount: 5 });
    expect(result.manifest.workspace.discover.projectFiles).toEqual(["apps/*/project.json", "libs/**/project.json"]);
    expect(result.pureFactories).toEqual(["z.*"]);
    expect(result.manifest.workspace.discover.targetTemplates.map((template) => template.target)).toEqual([
      "test",
      "typecheck",
      "lint",
    ]);
    expect(
      result.manifest.workspace.discover.targetTemplates.find((template) => template.target === "lint")?.execution,
    ).toEqual({ executable: "npx", args: ["nx", "run", "{project}:lint"] });
  });

  it("translates pnpm-workspace.yaml negations into excludeRoots and emits --json envelope", async () => {
    const workspaceRoot = makeWorkspace({
      "package.json": JSON.stringify({ name: "pnpm-mono" }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n  - '!packages/ignored/*'\n",
      "packages/api/package.json": JSON.stringify({ name: "api", scripts: { test: "node --test", build: "tsc -b" } }),
    });
    const harness = createHarness(workspaceRoot);

    const exitCode = await runDadTestCli(
      ["init", "--discover", "--json", "--manifest", "custom.testing.json"],
      harness.io,
    );

    expect(exitCode).toBe(0);
    expect(harness.stderr()).toBe("");
    expect(JSON.parse(harness.stdout())).toMatchObject({
      schemaVersion: 1,
      ok: true,
      result: {
        manifestPath: "custom.testing.json",
        manifest: {
          workspace: {
            discover: {
              projectFiles: ["packages/*/package.json"],
              excludeRoots: ["packages/ignored/*"],
            },
          },
        },
      },
    });
  });

  it("respects --force and leaves no manifest behind when native validation rejects", async () => {
    const workspaceRoot = makeWorkspace({
      "package.json": JSON.stringify({ name: "solo", scripts: { test: "node --test" } }),
      "dads.testing.json": "previous\n",
    });

    const refuseHarness = createHarness(workspaceRoot);
    expect(await runDadTestCli(["init", "--discover"], refuseHarness.io)).toBe(1);
    expect(refuseHarness.stderr()).toContain("Refusing to overwrite existing dads.testing.json");
    expect(readFileSync(join(workspaceRoot, "dads.testing.json"), "utf8")).toBe("previous\n");

    const rejecting = createFakeNativeBinary(makeTemporaryDirectory(), {
      schemaVersion: 1,
      ok: false,
      error: "Invalid discover template.",
    });
    const rejectHarness = createHarness(workspaceRoot, rejecting.binary);
    expect(await runDadTestCli(["init", "--discover", "--force"], rejectHarness.io)).toBe(1);
    expect(rejectHarness.stderr()).toContain("Generated discover manifest was rejected by dad-test");
    expect(readFileSync(join(workspaceRoot, "dads.testing.json"), "utf8")).toBe("previous\n");
    expect(temporaryFilesIn(workspaceRoot)).toEqual([]);
  });

  it("fails closed on dynamic setupFiles and handles single-string setupFiles + drizzle directory detection", () => {
    const dynamicDir = makeWorkspace({
      "vitest.config.mjs": "export default { test: { setupFiles: computeSetup() } };\n",
    });
    expect(detectRootVitestConfig(dynamicDir)).toEqual({
      configPath: "vitest.config.mjs",
      setupFiles: [],
      dynamicSetupFiles: true,
    });

    const singleDir = makeWorkspace({
      "vitest.config.js": "export default { test: { setupFiles: './vitest.setup.ts' } };\n",
      "drizzle/0000.sql": "SELECT 1;\n",
      "package.json": JSON.stringify({ dependencies: { zod: "^4.0.0" } }),
    });
    expect(detectRootVitestConfig(singleDir)).toEqual({
      configPath: "vitest.config.js",
      setupFiles: ["vitest.setup.ts"],
      dynamicSetupFiles: false,
    });
    expect(detectSqlMigrationRoots(singleDir)).toEqual(["drizzle"]);
    expect(detectWorkspacePureFactories(singleDir)).toEqual(["z.*"]);
  });
});

function makeWorkspace(files: Readonly<Record<string, string>>): string {
  const directory = makeTemporaryDirectory();
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(directory, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
  return directory;
}

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dads-testing-init-discover-"));
  temporaryDirectories.push(directory);
  return directory;
}

function temporaryFilesIn(directory: string): readonly string[] {
  return readdirSync(directory).filter((entry) => entry.endsWith(".tmp"));
}

function readJsonObject(filePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isRecord(parsed)) throw new Error(`Expected JSON object in ${filePath}`);
  return parsed;
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
  return { io, stdout: () => stdoutChunks.join(""), stderr: () => stderrChunks.join("") };
}
