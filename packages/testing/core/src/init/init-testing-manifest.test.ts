import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseTestingManifest } from "../testing-manifest.js";
import { createFakeNativeBinary } from "../test-support/native-fixture.js";
import { initReportFileName, initTestingManifest } from "./init-testing-manifest.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const corePackage = JSON.stringify({
  name: "@scope/core",
  scripts: { test: "vitest run", typecheck: "tsc -b" },
});

const apiPackage = JSON.stringify({
  name: "@scope/api",
  scripts: { test: "vitest run" },
  dependencies: { "@scope/core": "*" },
});

const webPackage = JSON.stringify({
  name: "@scope/web",
  scripts: { test: "vitest run" },
});

/** Comments and a trailing comma, the way a real tsconfig.json is written. */
const webTsconfig = [
  "{",
  "  // The web package is built on core.",
  '  "references": [{ "path": "../core/tsconfig.json" }],',
  "}",
  "",
].join("\n");

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
      counts: { run: 2, skipProvenUnaffected: 0 },
    },
  },
};

describe("manifest generation", () => {
  it("reads npm workspaces declared as an array", async () => {
    const workspaceRoot = makeWorkspace({
      "package.json": JSON.stringify({
        name: "workspace",
        workspaces: ["packages/*"],
      }),
      "package-lock.json": "{}",
      "packages/core/package.json": corePackage,
      "packages/api/package.json": apiPackage,
    });

    const result = await initTestingManifest(structural(workspaceRoot));

    expect(result.manifestPath).toBe("dads.testing.json");
    expect(result.reportPath).toBe(initReportFileName);
    expect(result.report.workspace).toEqual({
      packageManager: "npm",
      packageManagerSource: "package-lock.json",
      patternSource: "package.json#workspaces",
      patterns: ["packages/*"],
      ignoredWorkspaceKeys: [],
    });
    expect(result.manifest.projects).toEqual([
      {
        id: "scope-api",
        root: "packages/api",
        fallbackDependencies: ["scope-core"],
      },
      { id: "scope-core", root: "packages/core", fallbackDependencies: [] },
    ]);
    expect(result.manifest.tasks.map((task) => task.id)).toEqual([
      "scope-api:test",
      "scope-core:test",
      "scope-core:typecheck",
    ]);
    expect(writtenManifestTaskIds(workspaceRoot)).toEqual([
      "scope-api:test",
      "scope-core:test",
      "scope-core:typecheck",
    ]);
    expect(result.report.validation).toEqual({
      method: "structural",
      ok: true,
      messages: [],
    });
    expect(result.report.manifestChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(readReport(workspaceRoot)).toEqual(result.report);
  });

  it("reads npm workspaces declared as an object", async () => {
    const workspaceRoot = makeWorkspace({
      "package.json": JSON.stringify({
        name: "workspace",
        workspaces: { packages: ["packages/*"] },
      }),
      "packages/core/package.json": corePackage,
    });

    const result = await initTestingManifest(structural(workspaceRoot));

    expect(result.report.workspace.patternSource).toBe("package.json#workspaces");
    expect(result.report.workspace.patterns).toEqual(["packages/*"]);
    expect(result.manifest.projects.map((project) => project.id)).toEqual(["scope-core"]);
  });

  it("runs scripts with yarn when a yarn lockfile is present", async () => {
    const workspaceRoot = makeWorkspace({
      "package.json": JSON.stringify({
        name: "workspace",
        workspaces: ["packages/*"],
      }),
      "yarn.lock": "",
      "packages/core/package.json": corePackage,
    });

    const result = await initTestingManifest(structural(workspaceRoot));

    expect(result.report.workspace.packageManagerSource).toBe("yarn.lock");
    expect(result.manifest.tasks[0]?.execution).toEqual({
      executable: "yarn",
      args: ["run", "test"],
      cwd: "packages/core",
    });
  });

  it("reads pnpm patterns and TypeScript project references", async () => {
    const workspaceRoot = makeWorkspace({
      "package.json": JSON.stringify({ name: "workspace" }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "pnpm-workspace.yaml": ["packages:", "  - packages/*", "catalog:", "  vitest: ^4.0.0", ""].join("\n"),
      "packages/core/package.json": corePackage,
      "packages/core/tsconfig.json": "{}",
      "packages/web/package.json": webPackage,
      "packages/web/tsconfig.json": webTsconfig,
    });

    const result = await initTestingManifest(structural(workspaceRoot));

    expect(result.report.workspace).toEqual({
      packageManager: "pnpm",
      packageManagerSource: "pnpm-lock.yaml",
      patternSource: "pnpm-workspace.yaml",
      patterns: ["packages/*"],
      ignoredWorkspaceKeys: ["catalog"],
    });
    expect(result.manifest.tasks[0]?.execution.executable).toBe("pnpm");
    expect(result.manifest.projects.find((project) => project.id === "scope-web")?.fallbackDependencies).toEqual([
      "scope-core",
    ]);
    expect(result.report.unsupported).toEqual([]);
  });

  it("treats a workspace without patterns as one package at the root", async () => {
    const workspaceRoot = makeWorkspace({
      "package.json": JSON.stringify({
        name: "solo",
        scripts: { test: "vitest run", lint: "eslint ." },
      }),
    });

    const result = await initTestingManifest(structural(workspaceRoot));

    expect(result.report.workspace.patternSource).toBe("single-package");
    expect(result.report.workspace.packageManagerSource).toBe("default");
    expect(result.manifest.projects).toEqual([{ id: "solo", root: ".", fallbackDependencies: [] }]);
    expect(result.manifest.tasks.map((task) => task.execution)).toEqual([
      { executable: "npm", args: ["run", "lint"] },
      { executable: "npm", args: ["run", "test"] },
    ]);
  });

  it("refuses to replace a manifest without force, and replaces it with force", async () => {
    const workspaceRoot = makeWorkspace({
      "package.json": JSON.stringify({
        name: "solo",
        scripts: { test: "vitest run" },
      }),
      "dads.testing.json": "existing\n",
    });

    await expect(initTestingManifest(structural(workspaceRoot))).rejects.toThrow(
      "Refusing to overwrite existing dads.testing.json; pass --force to replace it.",
    );
    expect(readFileSync(join(workspaceRoot, "dads.testing.json"), "utf8")).toBe("existing\n");
    expect(existsSync(join(workspaceRoot, initReportFileName))).toBe(false);

    const result = await initTestingManifest({
      ...structural(workspaceRoot),
      force: true,
    });

    expect(result.manifest.tasks.map((task) => task.id)).toEqual(["solo:test"]);
    expect(writtenManifestTaskIds(workspaceRoot)).toEqual(["solo:test"]);
  });

  it("writes only the report when nothing declares a recognized script", async () => {
    const workspaceRoot = makeWorkspace({
      "package.json": JSON.stringify({
        name: "solo",
        scripts: { start: "node server.js" },
      }),
    });

    await expect(initTestingManifest(structural(workspaceRoot))).rejects.toThrow(
      "No recognized test, typecheck, lint, or build scripts were found; wrote dads.testing.init-report.json and no manifest.",
    );
    expect(existsSync(join(workspaceRoot, "dads.testing.json"))).toBe(false);
    const report = readReport(workspaceRoot);
    expect(report["validation"]).toEqual({
      method: "none",
      ok: false,
      messages: ["No recognized test, typecheck, lint, or build scripts were found."],
    });
    expect(report["manifestChecksum"]).toBeNull();
    expect(report["packages"]).toEqual([
      {
        directory: ".",
        name: "solo",
        tasks: [],
        skipped: "no-recognized-scripts",
      },
    ]);
  });

  it("validates the generated manifest with the native engine", async () => {
    const workspaceRoot = makeWorkspace({
      "package.json": JSON.stringify({
        name: "solo",
        scripts: { test: "vitest run", typecheck: "tsc -b" },
      }),
    });
    const fixture = createFakeNativeBinary(makeTemporaryDirectory(), planResponse);

    const result = await initTestingManifest({
      workspaceRoot,
      nativeBinary: fixture.binary,
      environment: {},
    });

    expect(result.report.validation).toEqual({
      method: "native",
      ok: true,
      messages: [],
      selectedTaskCount: 2,
    });
    const request = fixture.readRequest();
    expect(request).toMatchObject({
      operation: "plan",
      workspaceRoot,
      all: true,
      taskIds: [],
    });
    expect(readStringField(request, "manifestPath")).toMatch(/^dads\.testing\.json\..+\.tmp$/);
    expect(writtenManifestTaskIds(workspaceRoot)).toEqual(["solo:test", "solo:typecheck"]);
    expect(temporaryFilesIn(workspaceRoot)).toEqual([]);
  });

  it("leaves no manifest behind when the engine rejects it", async () => {
    const workspaceRoot = makeWorkspace({
      "package.json": JSON.stringify({
        name: "solo",
        scripts: { test: "vitest run" },
      }),
    });
    const fixture = createFakeNativeBinary(makeTemporaryDirectory(), {
      schemaVersion: 1,
      ok: false,
      error: "Manifest must declare at least one task.",
    });

    await expect(
      initTestingManifest({
        workspaceRoot,
        nativeBinary: fixture.binary,
        environment: {},
      }),
    ).rejects.toThrow("Generated manifest was rejected by dad-test: Manifest must declare at least one task.");
    expect(existsSync(join(workspaceRoot, "dads.testing.json"))).toBe(false);
    expect(temporaryFilesIn(workspaceRoot)).toEqual([]);
    const report = readReport(workspaceRoot);
    expect(report["validation"]).toEqual({
      method: "native",
      ok: false,
      messages: ["Manifest must declare at least one task."],
    });
    expect(report["manifestChecksum"]).toBeNull();
  });

  it("takes the structural path when no native engine is resolved", async () => {
    const workspaceRoot = makeWorkspace({
      "package.json": JSON.stringify({
        name: "solo",
        scripts: { test: "vitest run" },
      }),
    });
    const fixture = createFakeNativeBinary(makeTemporaryDirectory(), planResponse);

    const result = await initTestingManifest({
      workspaceRoot,
      nativeBinary: fixture.binary,
      environment: {},
      resolveNativeBinary: () => undefined,
    });

    expect(result.report.validation.method).toBe("structural");
    expect(result.report.validation.selectedTaskCount).toBeUndefined();
    expect(existsSync(join(workspaceRoot, "dads.testing.json"))).toBe(true);
  });
});

function structural(workspaceRoot: string): {
  readonly workspaceRoot: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly resolveNativeBinary: () => string | undefined;
} {
  return {
    workspaceRoot,
    environment: {},
    resolveNativeBinary: () => undefined,
  };
}

function writtenManifestTaskIds(workspaceRoot: string): readonly string[] {
  const manifest = parseTestingManifest(
    readFileSync(join(workspaceRoot, "dads.testing.json"), "utf8"),
    "dads.testing.json",
  );
  return manifest.tasks.map((task) => task.id);
}

function readReport(workspaceRoot: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(workspaceRoot, initReportFileName), "utf8"));
  if (!isRecord(parsed)) {
    throw new Error("The init report must be a JSON object.");
  }
  return parsed;
}

function readStringField(value: unknown, key: string): string {
  if (!isRecord(value)) throw new Error(`Expected an object holding ${key}.`);
  const field = value[key];
  if (typeof field !== "string") throw new Error(`Expected a string ${key}.`);
  return field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function temporaryFilesIn(directory: string): readonly string[] {
  return readdirSync(directory).filter((entry) => entry.endsWith(".tmp"));
}

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dads-testing-init-"));
  temporaryDirectories.push(directory);
  return directory;
}

function makeWorkspace(files: Readonly<Record<string, string>>): string {
  const directory = makeTemporaryDirectory();
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(directory, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
  return directory;
}
