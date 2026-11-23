import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dadsIdentifier } from "./dads-identifier.js";
import { isRecord } from "../parse-guards.js";
import { planNativeNxTesting } from "./nx-native-workspace.js";
import type { NativeNxCoverage } from "./nx-native-model.js";

/**
 * A generated workspace shaped like the plugin-based Nx repositories this adapter exists for:
 * `nx.json` carries plugins, `targetDefaults` and named inputs; every target is plugin-inferred,
 * with an executor, options, and configurations rather than a command; one target names a
 * prerequisite in a project outside its own dependency graph; and one project reads a runtime
 * input. Everything here is written by this file — nothing is copied from a real repository.
 */

const run = promisify(execFile);

type ManifestTask = {
  readonly id: string;
  readonly project: string;
  readonly impact: {
    readonly mode: string;
    readonly paths?: readonly string[];
  };
};
type Manifest = {
  readonly projects: readonly { readonly id: string; readonly root: string }[];
  readonly tasks: readonly ManifestTask[];
  readonly workspace: {
    readonly fullFallback: { readonly taskIds: readonly string[] };
  };
};

let workspace = "";
let manifest: Manifest;
let coverage: NativeNxCoverage;

beforeAll(async () => {
  workspace = await createPluginWorkspace();
  const result = await planNativeNxTesting({
    workspaceRoot: workspace,
    nativeBinary: path.join(workspace, "fake-dad-test.mjs"),
  });
  coverage = result.coverage;
  const captured: unknown = JSON.parse(await readFile(path.join(workspace, "tmp", "captured-manifest.json"), "utf8"));
  if (!isManifest(captured)) throw new Error("The adapter wrote a manifest this fixture cannot read.");
  manifest = captured;
});

/** The manifest fields these assertions read, checked rather than asserted. */
function isManifest(value: unknown): value is Manifest {
  return (
    isRecord(value) && isRecord(value["workspace"]) && Array.isArray(value["projects"]) && Array.isArray(value["tasks"])
  );
}

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("native Nx scopes for a plugin-inferred workspace", () => {
  it("narrows a plugin-inferred workspace to the changed project and its dependents", () => {
    expect(coverage).toMatchObject({ projects: 6, registered: 11, always: 2 });
    expect(selected("libs/platform/src/index.ts")).toEqual(ids(["platform", "catalog", "storefront", "reporting"]));
    expect(selected("libs/catalog/src/index.ts")).toEqual(ids(["catalog", "storefront", "reporting"]));
    expect(selected("apps/standalone/src/index.ts")).toEqual(ids(["standalone", "reporting"]));
  });

  it("follows a prerequisite into a project the dependency graph does not reach", () => {
    expect(selected("tools/codegen/src/index.ts")).toEqual(
      [...ids(["codegen", "reporting"]), taskId("catalog", "test")].sort(),
    );
  });

  it("expands targetDefaults and named inputs into the paths they name", () => {
    expect(pathsOf("catalog", "lint")).toEqual([
      "eslint.config.js",
      "libs/catalog",
      "libs/platform",
      "nx.json",
      "package-lock.json",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tooling/vitest-preset.ts",
      "tsconfig.base.json",
      "tsconfig.json",
      "yarn.lock",
    ]);
    expect(pathsOf("catalog", "test")).toContain("tooling/vitest-preset.ts");
    expect(pathsOf("catalog", "test")).not.toContain("eslint.config.js");
    expect(pathsOf("standalone", "test")).toEqual([
      "apps/standalone",
      "nx.json",
      "package-lock.json",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tooling/vitest-preset.ts",
      "tsconfig.base.json",
      "tsconfig.json",
      "yarn.lock",
    ]);
  });

  it("sends an unowned root configuration change to the complete fallback", () => {
    expect(manifest.projects.some((project) => pathIsInside("workspace-checks.json", project.root))).toBe(false);
    expect(selected("workspace-checks.json")).toEqual(manifest.workspace.fullFallback.taskIds);
  });

  it("keeps a runtime named input on always and counts exactly those tasks", () => {
    expect(
      manifest.tasks
        .filter((task) => task.impact.mode === "always")
        .map((task) => task.id)
        .sort(),
    ).toEqual(ids(["reporting"]));
    for (const audit of coverage.tasks) {
      if (audit.project !== "reporting" || audit.classification !== "registered") continue;
      expect(audit.impactMode).toBe("always");
      expect(audit.reason).toBe("non-file or unresolved input");
    }
    const narrowed = coverage.tasks.find((audit) => audit.project === "catalog");
    expect(narrowed?.impactMode).toBe("changed-files");
    expect(narrowed?.reason).toContain("plugin-inferred inputs assumed");
  });
});

// ---------------------------------------------------------------------------
// The engine's selection rules, applied to what the adapter declared
// ---------------------------------------------------------------------------

/**
 * `packages/testing/core`'s README states the rules that decide these tasks: an `always` task runs
 * in every plan, a `changed-files` task runs when a changed path is inside one of its declared
 * paths, and a changed path no declared project owns selects the complete fallback. The engine
 * owns the real implementation; repeating it here lets the fixture assert on the manifest this
 * adapter actually sent rather than on a canned plan.
 */
function selected(changedPath: string): readonly string[] {
  const owned = manifest.projects.some((project) => pathIsInside(changedPath, project.root));
  if (!owned) return [...manifest.workspace.fullFallback.taskIds].sort();
  return manifest.tasks
    .filter(
      (task) =>
        task.impact.mode === "always" || (task.impact.paths ?? []).some((owner) => pathIsInside(changedPath, owner)),
    )
    .map((task) => task.id)
    .sort();
}

function pathIsInside(candidate: string, owner: string): boolean {
  return owner === "." || candidate === owner || candidate.startsWith(`${owner}/`);
}

function ids(projects: readonly string[]): readonly string[] {
  const wanted = new Set(projects.map(dadsIdentifier));
  return manifest.tasks
    .filter((task) => wanted.has(task.project))
    .map((task) => task.id)
    .sort();
}

function taskId(project: string, target: string): string {
  return `${dadsIdentifier(project)}:${dadsIdentifier(target)}`;
}

function pathsOf(project: string, target: string): readonly string[] {
  const wanted = taskId(project, target);
  return manifest.tasks.find((task) => task.id === wanted)?.impact.paths ?? [];
}

// ---------------------------------------------------------------------------
// The generated workspace
// ---------------------------------------------------------------------------

const projectRoots: Readonly<Record<string, string>> = {
  platform: "libs/platform",
  catalog: "libs/catalog",
  storefront: "apps/storefront",
  standalone: "apps/standalone",
  reporting: "apps/reporting",
  codegen: "tools/codegen",
};

const projectEdges: Readonly<Record<string, readonly string[]>> = {
  platform: [],
  catalog: ["platform"],
  storefront: ["catalog"],
  standalone: [],
  reporting: [],
  codegen: [],
};

async function createPluginWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "dads-testing-nx-plugin-"));
  await writeFile(path.join(root, ".gitignore"), "tmp/\nnode_modules/\n");
  await writeFile(path.join(root, "nx.json"), stableJson(nxConfiguration()));
  await writeFile(path.join(root, "graph-definition.json"), stableJson(projectGraph()));
  await writeFile(path.join(root, "package.json"), '{"name":"plugin-fixture"}\n');
  await writeFile(path.join(root, "eslint.config.js"), "export default [];\n");
  await writeFile(path.join(root, "workspace-checks.json"), "{}\n");
  await mkdir(path.join(root, "tooling"), { recursive: true });
  await writeFile(path.join(root, "tooling", "vitest-preset.ts"), "export const preset = {};\n");
  for (const directory of Object.values(projectRoots)) {
    await mkdir(path.join(root, directory, "src"), { recursive: true });
    await writeFile(path.join(root, directory, "src", "index.ts"), "export const value = 1;\n");
  }
  await writeFile(path.join(root, "fake-dad-test.mjs"), fakeDadTestSource());
  await chmod(path.join(root, "fake-dad-test.mjs"), 0o755);
  await commitWorkspace(root);
  await installFakeNx(root);
  return root;
}

async function commitWorkspace(root: string): Promise<void> {
  await run("git", ["init", "-q"], { cwd: root });
  await run("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  await run("git", ["config", "user.name", "Dads Test"], { cwd: root });
  await run("git", ["add", "."], { cwd: root });
  await run("git", ["commit", "-qm", "fixture"], { cwd: root });
}

async function installFakeNx(root: string): Promise<void> {
  const nxDirectory = path.join(root, "node_modules", "nx");
  await mkdir(path.join(nxDirectory, "bin"), { recursive: true });
  await writeFile(path.join(nxDirectory, "bin", "nx.mjs"), fakeNxSource());
  await chmod(path.join(nxDirectory, "bin", "nx.mjs"), 0o755);
  await writeFile(path.join(nxDirectory, "package.json"), '{"name":"nx","bin":{"nx":"./bin/nx.mjs"}}\n');
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function nxConfiguration(): Record<string, unknown> {
  return {
    plugins: ["@nx/vite/plugin", "@nx/eslint/plugin"],
    namedInputs: {
      default: ["{projectRoot}/**/*", "sharedGlobals"],
      production: ["default", "!{projectRoot}/**/*.test.ts"],
      sharedGlobals: ["{workspaceRoot}/tooling/vitest-preset.ts"],
      hostTooling: [{ runtime: "node --version" }],
    },
    targetDefaults: {
      lint: { inputs: ["default", "{workspaceRoot}/eslint.config.js"] },
      "@nx/vite:test": {
        inputs: ["default", "^production", { externalDependencies: ["vitest"] }],
      },
    },
  };
}

function projectGraph(): Record<string, unknown> {
  const nodes: Record<string, unknown> = {};
  const dependencies: Record<string, unknown> = {};
  for (const [name, root] of Object.entries(projectRoots)) {
    nodes[name] = {
      name,
      data: { name, root, targets: inferredTargets(name) },
    };
    dependencies[name] = (projectEdges[name] ?? []).map((target) => ({
      source: name,
      target,
      type: "static",
    }));
  }
  return { graph: { nodes, dependencies } };
}

/** Plugin-inferred targets: an executor, options, configurations, and no command anywhere. */
function inferredTargets(name: string): Record<string, unknown> {
  if (name === "codegen")
    return {
      build: { executor: "@nx/js:tsc", options: { main: "src/index.ts" } },
    };
  const runtimeInputs = { inputs: ["default", "hostTooling"] };
  return {
    test: {
      executor: "@nx/vite:test",
      options: { config: "vite.config.ts" },
      configurations: { ci: { reporters: ["default"] } },
      defaultConfiguration: "ci",
      ...(name === "catalog" ? { dependsOn: [{ projects: ["codegen"], target: "build" }] } : {}),
      ...(name === "reporting" ? runtimeInputs : {}),
    },
    lint: {
      executor: "@nx/eslint:lint",
      options: { lintFilePatterns: ["{projectRoot}"] },
      ...(name === "reporting" ? runtimeInputs : {}),
    },
    serve: { executor: "@nx/vite:dev-server", continuous: true },
  };
}

function fakeNxSource(): string {
  return `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const file = process.argv.find((value) => value.startsWith("--file="));
if (!process.argv.includes("graph") || !file) process.exit(9);
const definition = JSON.parse(readFileSync(path.join(process.cwd(), "graph-definition.json"), "utf8"));
writeFileSync(file.slice("--file=".length), JSON.stringify(definition.graph));
`;
}

/** Copies the manifest the adapter wrote in its ignored scratch directory back out. */
function fakeDadTestSource(): string {
  return `#!/usr/bin/env node
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
mkdirSync(path.join(request.workspaceRoot, "tmp"), { recursive: true });
copyFileSync(path.join(request.workspaceRoot, request.manifestPath), path.join(request.workspaceRoot, "tmp", "captured-manifest.json"));
process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: true, result: { operation: request.operation, plan: { schemaVersion: 1, scope: { kind: "working-tree", changedPaths: [], fullFallback: false }, tasks: [], issues: [], complete: true, counts: { run: 0, skipProvenUnaffected: 0 } } } }));
`;
}
