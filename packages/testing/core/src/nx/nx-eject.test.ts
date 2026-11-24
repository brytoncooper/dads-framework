import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { planTesting } from "../testing-api.js";
import { ejectNativeNxTesting, ejectReportFileName } from "./nx-eject-workspace.js";
import { ejectTarget } from "./nx-eject-targets.js";
import { inspectVitestConfig, rewriteNxViteTsPaths } from "./nx-eject-vitest.js";

const run = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("dad-test-nx eject", () => {
  it("previews standalone tasks, Vitest fileNarrowing, nxViteTsPaths configs, and uninstall commands in dry-run", async () => {
    const workspace = await createNxWorkspace();
    const result = await ejectNativeNxTesting({ workspaceRoot: workspace });

    expect(result.written).toBe(false);
    expect(existsSync(path.join(workspace, "dads.testing.json"))).toBe(false);
    expect(existsSync(path.join(workspace, ejectReportFileName))).toBe(false);
    expect(result.report.dryRun).toBe(true);
    expect(result.report.summary).toMatchObject({
      projects: 4,
      converted: 6,
      opaque: 1,
      vitestNarrowed: 1,
      nxViteConfigsFound: 1,
      nxViteConfigsRewritten: 0,
    });

    const billingTest = result.manifest.tasks.find((t) => t.id === "billing:test");
    expect(billingTest?.execution).toEqual({
      executable: "npx",
      args: ["vitest", "run"],
      cwd: "libs/billing",
      fileNarrowing: {
        suffixes: [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"],
        setupFiles: ["libs/billing/src/test-setup.ts"],
      },
    });
    expect(billingTest?.impact.mode).toBe("reachability");
    expect(billingTest?.impact.paths).toContain("libs/billing/vitest.config.ts");

    const dynamicTest = result.manifest.tasks.find((t) => t.id === "dynamic:test");
    expect(dynamicTest?.execution.fileNarrowing).toBeUndefined();
    expect(dynamicTest?.impact.mode).toBe("reachability");

    const billingLint = result.manifest.tasks.find((t) => t.id === "billing:lint");
    expect(billingLint?.execution).toEqual({ executable: "npx", args: ["eslint", "."], cwd: "libs/billing" });
    expect(billingLint?.dependsOn).toEqual(["workspace-scripts:lint-walls"]);
    expect(billingLint?.impact.mode).toBe("reachability");

    const gate = result.manifest.tasks.find((t) => t.id === "workspace-scripts:lint-walls");
    expect(gate?.execution).toEqual({ executable: "node", args: ["scripts/lint-walls.mjs"] });
    expect(gate?.impact.mode).toBe("always");

    const billingTypecheck = result.manifest.tasks.find((t) => t.id === "billing:typecheck");
    expect(billingTypecheck?.execution).toEqual({
      executable: "npx",
      args: ["tsc", "--noEmit", "-p", "libs/billing/tsconfig.lib.json"],
      cwd: ".",
    });
    expect(billingTypecheck?.impact.mode).toBe("reachability");

    expect(result.report.nxPackagesDetected).toEqual(["@nx/eslint", "@nx/js", "@nx/vite", "nx"]);
    expect(result.report.uninstallCommands).toContain("rm -rf nx.json .nx");
    expect(result.report.uninstallCommands).toContain("npm uninstall @nx/eslint @nx/js @nx/vite nx");
  });

  it("normalizes empty and workspaceRoot cwd values in nx:run-commands targets instead of emitting cwd: ''", () => {
    const project = {
      name: "domain-access",
      root: "libs/domain-access",
      targets: {},
      dependencies: [],
      namedInputs: undefined,
    };
    const projects = new Map([[project.name, project]]);
    for (const cwd of ["", "   ", "{workspaceRoot}", "{workspaceRoot}/", "."]) {
      const ejected = ejectTarget({
        workspaceRoot: "/tmp/unused",
        project,
        name: "test:integration",
        target: { executor: "nx:run-commands", options: { command: "node --version", cwd } },
        projects,
        nxConfiguration: {},
      });
      expect(ejected.audit.classification).toBe("converted");
      expect(ejected.task?.id).toBe("domain-access:test:integration");
      expect(ejected.task?.execution.cwd).toBeUndefined();
    }
  });

  it("writes dads.testing.json, rewrites nxViteTsPaths to dadsTsconfigPaths, and runs with zero Nx installed", async () => {
    const workspace = await createNxWorkspace();
    const nativeBinary = findLocalNativeBinary();

    const result = await ejectNativeNxTesting({
      workspaceRoot: workspace,
      write: true,
      replaceNxViteTsPaths: true,
      ...(nativeBinary === undefined ? {} : { nativeBinary }),
    });

    expect(result.written).toBe(true);
    expect(result.report.summary.nxViteConfigsRewritten).toBe(1);
    const rewrittenConfig = await readFile(path.join(workspace, "libs/billing/vitest.config.ts"), "utf8");
    expect(rewrittenConfig).not.toContain("nxViteTsPaths");
    expect(rewrittenConfig).toContain('import { dadsTsconfigPaths } from "@dads-framework/testing/vitest";');
    expect(rewrittenConfig).toContain('fileURLToPath(new URL("../../tsconfig.base.json", import.meta.url))');

    // Refuses overwrite without --force
    await expect(ejectNativeNxTesting({ workspaceRoot: workspace, write: true })).rejects.toThrow(
      "Refusing to overwrite existing dads.testing.json",
    );

    if (nativeBinary !== undefined) {
      // Remove Nx completely from the workspace and prove standalone dad-test plans with per-file Vitest narrowing!
      await rm(path.join(workspace, "nx.json"), { force: true });
      await rm(path.join(workspace, "node_modules/nx"), { recursive: true, force: true });
      await run("git", ["add", "."], { cwd: workspace });
      await run("git", ["commit", "-qm", "ejected off nx"], { cwd: workspace });

      await writeFile(
        path.join(workspace, "libs/billing/src/invoice.ts"),
        "export function invoiceTotal() { return 42; }\nexport function unusedHelper() { return 0; }\n",
      );

      const plan = await planTesting({
        workspaceRoot: workspace,
        all: false,
        taskIds: [],
        nativeBinary,
      });
      const billingTest = plan.tasks.find((t) => t.id === "billing:test");
      expect(billingTest?.decision).toBe("run");
      expect(billingTest?.selectedFiles).toEqual(["libs/billing/src/invoice.test.ts"]);
      const dynamicTest = plan.tasks.find((t) => t.id === "dynamic:test");
      expect(dynamicTest?.decision).toBe("skip-proven-unaffected");
    }
  });

  it("leaves custom nxViteTsPaths calls for manual review and flags dynamic setupFiles", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dads-nx-eject-vitest-"));
    tempDirs.push(dir);
    await writeFile(path.join(dir, "tsconfig.base.json"), "{}\n");
    const customConfig = [
      'import { nxViteTsPaths } from "@nx/vite/plugins/nx-tsconfig-paths.plugin";',
      "export default { plugins: [nxViteTsPaths({ debug: true })], test: { setupFiles: getSetupFiles() } };",
    ].join("\n");
    await writeFile(path.join(dir, "vitest.config.ts"), customConfig);

    const inspection = inspectVitestConfig(dir, ".");
    expect(inspection.usesNxViteTsPaths).toBe(true);
    expect(inspection.dynamicSetupFiles).toBe(true);

    const rewrite = rewriteNxViteTsPaths(dir, "vitest.config.ts", "tsconfig.base.json");
    expect(rewrite.status).toBe("manual-review-needed");
    expect(await readFile(path.join(dir, "vitest.config.ts"), "utf8")).toBe(customConfig);
  });
});

function findLocalNativeBinary(): string | undefined {
  for (const candidate of [
    path.resolve(process.cwd(), "target/release/dad-test"),
    path.resolve(process.cwd(), "target/debug/dad-test"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function createNxWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "dads-nx-eject-ws-"));
  tempDirs.push(root);
  await writeFile(path.join(root, ".gitignore"), "node_modules/\n.nx/\ntmp/\n");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "eject-fixture",
      devDependencies: { nx: "20.0.0", "@nx/vite": "20.0.0", "@nx/eslint": "20.0.0", "@nx/js": "20.0.0" },
    }),
  );
  await writeFile(path.join(root, "tsconfig.base.json"), '{ "compilerOptions": { "paths": {} } }\n');
  await writeFile(path.join(root, "nx.json"), JSON.stringify({ namedInputs: { default: ["{projectRoot}/**/*"] } }));

  await mkdir(path.join(root, "libs/billing/src"), { recursive: true });
  await mkdir(path.join(root, "libs/dynamic/src"), { recursive: true });
  await mkdir(path.join(root, "apps/legacy/src"), { recursive: true });
  await mkdir(path.join(root, "scripts"), { recursive: true });

  await writeFile(path.join(root, "scripts/lint-walls.mjs"), "console.log('ok');\n");
  await writeFile(path.join(root, "libs/billing/tsconfig.lib.json"), "{}\n");
  await writeFile(path.join(root, "libs/billing/src/test-setup.ts"), "export const ready = true;\n");
  await writeFile(
    path.join(root, "libs/billing/vitest.config.ts"),
    [
      'import { defineConfig } from "vitest/config";',
      'import { nxViteTsPaths } from "@nx/vite/plugins/nx-tsconfig-paths.plugin";',
      'export default defineConfig({ plugins: [nxViteTsPaths()], test: { setupFiles: ["./src/test-setup.ts"] } });',
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "libs/billing/src/invoice.ts"),
    "export function invoiceTotal() { return 10; }\nexport function unusedHelper() { return 0; }\n",
  );
  await writeFile(
    path.join(root, "libs/billing/src/invoice.test.ts"),
    'import { invoiceTotal } from "./invoice";\nexport const run = invoiceTotal();\n',
  );
  await writeFile(
    path.join(root, "libs/billing/src/other.test.ts"),
    'import { unusedHelper } from "./invoice";\nexport const run = unusedHelper();\n',
  );
  await writeFile(
    path.join(root, "libs/dynamic/vitest.config.ts"),
    "const files = ['./a.ts'];\nexport default { test: { setupFiles: files } };\n",
  );
  await writeFile(path.join(root, "libs/dynamic/src/index.ts"), "export const dyn = 1;\n");
  await writeFile(path.join(root, "apps/legacy/src/index.ts"), "export const leg = 1;\n");

  const graph = {
    graph: {
      nodes: {
        "workspace-scripts": {
          name: "workspace-scripts",
          data: {
            name: "workspace-scripts",
            root: ".",
            targets: {
              "lint-walls": {
                executor: "nx:run-commands",
                options: { command: "node scripts/lint-walls.mjs" },
                inputs: ["{workspaceRoot}/**/*"],
              },
            },
          },
        },
        billing: {
          name: "billing",
          data: {
            name: "billing",
            root: "libs/billing",
            targets: {
              test: { executor: "@nx/vite:test", options: {} },
              typecheck: { executor: "@nx/js:tsc", options: { tsConfig: "libs/billing/tsconfig.lib.json" } },
              lint: {
                executor: "@nx/eslint:lint",
                dependsOn: [{ projects: ["workspace-scripts"], target: "lint-walls" }],
              },
              serve: { executor: "@nx/vite:dev-server", continuous: true },
            },
          },
        },
        dynamic: {
          name: "dynamic",
          data: {
            name: "dynamic",
            root: "libs/dynamic",
            targets: {
              test: { executor: "@nx/vitest:test", options: {} },
              lint: {
                executor: "@nx/eslint:lint",
                dependsOn: [{ projects: ["workspace-scripts"], target: "lint-walls" }],
              },
            },
          },
        },
        legacy: {
          name: "legacy",
          data: {
            name: "legacy",
            root: "apps/legacy",
            targets: {
              build: { executor: "@nx/webpack:webpack", options: {} },
            },
          },
        },
      },
      dependencies: { "workspace-scripts": [], billing: [], dynamic: [], legacy: [] },
    },
  };
  await writeFile(path.join(root, "graph.json"), JSON.stringify(graph));

  const nxBinDir = path.join(root, "node_modules/nx/bin");
  await mkdir(nxBinDir, { recursive: true });
  await writeFile(
    path.join(root, "node_modules/nx/package.json"),
    JSON.stringify({ name: "nx", bin: { nx: "./bin/nx.mjs" } }),
  );
  await writeFile(
    path.join(nxBinDir, "nx.mjs"),
    '#!/usr/bin/env node\nimport { readFileSync, writeFileSync } from "node:fs";\nconst f = process.argv.find((a) => a.startsWith("--file="));\nwriteFileSync(f.slice(7), readFileSync("graph.json", "utf8"));\n',
  );
  await chmod(path.join(nxBinDir, "nx.mjs"), 0o755);

  await run("git", ["init", "-q"], { cwd: root });
  await run("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await run("git", ["config", "user.name", "Dads Test"], { cwd: root });
  await run("git", ["add", "."], { cwd: root });
  await run("git", ["commit", "-qm", "baseline"], { cwd: root });
  return root;
}
