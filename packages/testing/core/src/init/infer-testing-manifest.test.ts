import { describe, expect, it } from "vitest";
import type { DetectedWorkspace, PackageManager } from "./detect-workspace.js";
import { inferTestingManifest } from "./infer-testing-manifest.js";
import type { WorkspacePackage } from "./package-inventory.js";

describe("testing manifest inference", () => {
  it("runs every task through the detected package manager", () => {
    const packageManagers: readonly PackageManager[] = ["npm", "yarn", "pnpm"];
    for (const packageManager of packageManagers) {
      const inferred = inferTestingManifest(detected({ packageManager }), [
        workspacePackage("packages/core", "core", { test: "vitest run" }),
      ]);

      expect(inferred.manifest?.tasks).toEqual([
        {
          id: "core:test",
          project: "core",
          kind: "test",
          execution: {
            executable: packageManager,
            args: ["run", "test"],
            cwd: "packages/core",
          },
          dependsOn: [],
          impact: { mode: "reachability", paths: [] },
        },
      ]);
    }
  });

  it("maps each recognized script to its kind and impact mode", () => {
    const inferred = inferTestingManifest(detected(), [
      workspacePackage("packages/core", "core", {
        test: "vitest run",
        typecheck: "tsc -b",
        lint: "eslint .",
        build: "tsc -b",
        release: "npm publish",
      }),
    ]);

    expect(
      inferred.manifest?.tasks.map((task) => ({
        id: task.id,
        kind: task.kind,
        mode: task.impact.mode,
      })),
    ).toEqual([
      { id: "core:build", kind: "build", mode: "project" },
      { id: "core:lint", kind: "lint", mode: "project" },
      { id: "core:test", kind: "test", mode: "reachability" },
      { id: "core:typecheck", kind: "typecheck", mode: "project" },
    ]);
    expect(inferred.manifest?.workspace).toEqual({
      root: ".",
      fullFallback: {
        taskIds: ["core:build", "core:lint", "core:test", "core:typecheck"],
      },
    });
  });

  it("runs a package's test after its own typecheck", () => {
    const inferred = inferTestingManifest(detected(), [
      workspacePackage("packages/core", "core", {
        test: "vitest run",
        typecheck: "tsc -b",
      }),
    ]);

    expect(inferred.manifest?.tasks.find((task) => task.id === "core:test")?.dependsOn).toEqual(["core:typecheck"]);
    expect(inferred.manifest?.tasks.find((task) => task.id === "core:typecheck")?.dependsOn).toEqual([]);
    expect(inferred.report.inferences.filter((inference) => inference.kind === "depends-on")).toEqual([
      {
        kind: "depends-on",
        subject: "core:test",
        detail: "runs after core:typecheck",
      },
    ]);
  });

  it("falls back through package dependencies and project references", () => {
    const scripts = { test: "vitest run" };
    const inferred = inferTestingManifest(detected(), [
      workspacePackage("packages/core", "@scope/core", scripts),
      {
        ...workspacePackage("apps/api", "@scope/api", scripts),
        workspaceDependencies: ["@scope/core"],
      },
      {
        ...workspacePackage("apps/web", "@scope/web", scripts),
        tsconfigReferences: ["packages/core"],
      },
    ]);

    expect(inferred.manifest?.projects).toEqual([
      {
        id: "scope-api",
        root: "apps/api",
        fallbackDependencies: ["scope-core"],
      },
      { id: "scope-core", root: "packages/core", fallbackDependencies: [] },
      {
        id: "scope-web",
        root: "apps/web",
        fallbackDependencies: ["scope-core"],
      },
    ]);
    expect(inferred.report.inferences.filter((inference) => inference.kind === "fallback-dependency")).toEqual([
      {
        kind: "fallback-dependency",
        subject: "scope-api",
        detail: "declares a dependency on @scope/core, so it falls back to scope-core",
      },
      {
        kind: "fallback-dependency",
        subject: "scope-web",
        detail: "references the TypeScript project in packages/core, so it falls back to scope-core",
      },
    ]);
  });

  it("skips a package with no recognized scripts and says so", () => {
    const inferred = inferTestingManifest(detected(), [
      workspacePackage("packages/core", "core", { test: "vitest run" }),
      workspacePackage("packages/docs", "docs", { start: "serve" }),
      {
        ...workspacePackage("packages/broken"),
        packageJsonReadable: false,
        unsupported: [
          {
            subject: "packages/broken/package.json",
            message: "Unexpected end of JSON input.",
          },
        ],
      },
    ]);

    expect(inferred.report.packages).toEqual([
      {
        directory: "packages/core",
        name: "core",
        projectId: "core",
        projectIdSource: "package-name",
        tasks: [
          {
            id: "core:test",
            script: "test",
            kind: "test",
            impactMode: "reachability",
          },
        ],
      },
      {
        directory: "packages/docs",
        name: "docs",
        tasks: [],
        skipped: "no-recognized-scripts",
      },
      {
        directory: "packages/broken",
        tasks: [],
        skipped: "invalid-package-json",
      },
    ]);
    expect(inferred.report.unsupported).toEqual([
      {
        subject: "packages/broken/package.json",
        message: "Unexpected end of JSON input.",
      },
    ]);
  });

  it("returns no manifest when nothing declares a recognized script", () => {
    const inferred = inferTestingManifest(detected({ patternSource: "single-package", patterns: [] }), [
      workspacePackage(".", "workspace", { start: "serve" }),
    ]);

    expect(inferred.manifest).toBeUndefined();
    expect(inferred.report.packages).toEqual([
      {
        directory: ".",
        name: "workspace",
        tasks: [],
        skipped: "no-recognized-scripts",
      },
    ]);
    expect(inferred.report.inferences).toEqual([
      {
        kind: "package-manager",
        subject: "npm",
        detail: "from package-lock.json",
      },
      {
        kind: "root-package",
        subject: ".",
        detail: "no workspace patterns were declared; the root is the package",
      },
    ]);
  });

  it("omits the working directory for the workspace root", () => {
    const inferred = inferTestingManifest(detected({ patternSource: "single-package", patterns: [] }), [
      workspacePackage(".", "workspace", { test: "vitest run" }),
    ]);

    expect(inferred.manifest?.tasks[0]?.execution).toEqual({
      executable: "npm",
      args: ["run", "test"],
    });
    expect(inferred.manifest?.projects[0]?.root).toBe(".");
  });
});

function detected(overrides: Partial<DetectedWorkspace> = {}): DetectedWorkspace {
  return {
    packageManager: "npm",
    packageManagerSource: "package-lock.json",
    patternSource: "package.json#workspaces",
    patterns: ["packages/*"],
    packageDirectories: [],
    ignoredWorkspaceKeys: [],
    unsupported: [],
    ...overrides,
  };
}

function workspacePackage(
  directory: string,
  name?: string,
  scripts: Readonly<Record<string, string>> = {},
): WorkspacePackage {
  return {
    directory,
    ...(name === undefined ? {} : { name }),
    scripts,
    workspaceDependencies: [],
    tsconfigReferences: [],
    packageJsonReadable: true,
    unsupported: [],
  };
}
