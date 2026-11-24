import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { importNxTestingWorkspace, type NxCommandRunner } from "./import-nx.js";
import type { NxImportReport } from "./import-nx-types.js";

describe("importNxTestingWorkspace", () => {
  it("converts only a resolved argv-safe run-commands task and audits every seam", async () => {
    const workspaceRoot = await createWorkspace();
    const result = await importNxTestingWorkspace({
      workspaceRoot,
      expectedGitSha: fixtureSha,
      runner: nxFixtureRunner(workspaceRoot),
    });

    expect(result.manifest).toEqual({
      schemaVersion: 1,
      workspace: {
        root: ".",
        fullFallback: { taskIds: ["app:test"] },
      },
      projects: [
        {
          id: "app",
          root: "apps/app",
          fallbackDependencies: ["util"],
        },
        { id: "util", root: "libs/util", fallbackDependencies: [] },
      ],
      tasks: [
        {
          id: "app:test",
          project: "app",
          kind: "test",
          execution: {
            executable: "node",
            args: ["tools/test.mjs", "--label", "hello world"],
            cwd: "apps/app",
          },
          dependsOn: [],
          impact: { mode: "project" },
        },
      ],
    });
    expect(result.report.tasks.map((task) => [task.target, task.classification])).toEqual([
      ["lint", "native-adapter-needed"],
      ["shell", "opaque"],
      ["test", "converted"],
      ["vite", "native-adapter-needed"],
      ["watch", "excluded"],
    ]);
    expect(result.report.importer.manifestChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.report.source).toMatchObject({
      expectedGitSha: fixtureSha,
      resolvedGitSha: fixtureSha,
    });
    expect(result.report.nx.plugins).toEqual(["@nx/eslint/plugin", "@nx/vite/plugin"]);
    expect(JSON.parse(await readFile(result.manifestPath, "utf8"))).toEqual(result.manifest);
    expect(JSON.parse(await readFile(result.reportPath, "utf8"))).toEqual(result.report);
  });

  it("refuses a dirty source workspace before querying Nx", async () => {
    const workspaceRoot = await createWorkspace();
    const runner: NxCommandRunner = ({ executable, args }) => {
      if (executable === "git" && args[0] === "status")
        return Promise.resolve({
          stdout: " M apps/app/project.json\n",
          stderr: "",
        });
      throw new Error("Nx must not be queried for a dirty source workspace.");
    };

    await expect(
      importNxTestingWorkspace({
        workspaceRoot,
        expectedGitSha: fixtureSha,
        runner,
      }),
    ).rejects.toThrow("uncommitted or untracked changes");
  });

  it("refuses a caller snapshot that differs from clean HEAD before querying Nx", async () => {
    const workspaceRoot = await createWorkspace();
    const runner: NxCommandRunner = ({ executable, args }) => {
      if (executable === "git" && args[0] === "status") return Promise.resolve({ stdout: "", stderr: "" });
      if (executable === "git" && args[0] === "rev-parse")
        return Promise.resolve({ stdout: `${fixtureSha}\n`, stderr: "" });
      throw new Error("Nx must not be queried for a mismatched source snapshot.");
    };

    await expect(
      importNxTestingWorkspace({
        workspaceRoot,
        expectedGitSha: "fedcba9876543210fedcba9876543210fedcba98",
        runner,
      }),
    ).rejects.toThrow("does not match clean HEAD");
  });

  it("records the manifest checksum as the digest of the manifest file it wrote", async () => {
    const workspaceRoot = await createWorkspace();
    const result = await importNxTestingWorkspace({
      workspaceRoot,
      expectedGitSha: fixtureSha,
      runner: nxFixtureRunner(workspaceRoot),
    });

    const written = await readFile(result.manifestPath);

    expect(result.report.importer.manifestChecksum).toBe(createHash("sha256").update(written).digest("hex"));
  });

  it("leaves the unsupported-graph report behind when Nx cannot produce a graph", async () => {
    const workspaceRoot = await createWorkspace();

    await expect(
      importNxTestingWorkspace({
        workspaceRoot,
        expectedGitSha: fixtureSha,
        runner: nxFixtureRunner(workspaceRoot, { graphFails: true }),
      }),
    ).rejects.toThrow("Unsupported Nx interface: could not collect a machine-readable project graph");

    const report = await readReport(workspaceRoot);
    expect(report.importer.manifestChecksum).toBeNull();
    expect(report.nx.projectGraph).toBeNull();
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.stage).toBe("graph");
    expect(report.failures[0]?.subject).toBe("nx graph --file");
    expect(report.failures[0]?.message).toContain("could not collect a machine-readable project graph");
    await expect(readManifest(workspaceRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("leaves the unsupported-graph report behind when the graph shape is not understood", async () => {
    const workspaceRoot = await createWorkspace();
    const unsupported = {
      graph: {
        nodes: { app: { name: "app" }, util: { name: "util" } },
        dependencies: { app: [{ source: "util", target: "app" }], util: [] },
      },
    };

    await expect(
      importNxTestingWorkspace({
        workspaceRoot,
        expectedGitSha: fixtureSha,
        runner: nxFixtureRunner(workspaceRoot, { graph: unsupported }),
      }),
    ).rejects.toThrow(
      "Unsupported Nx graph shape: dependency edge for app does not declare matching source and target.",
    );

    const report = await readReport(workspaceRoot);
    expect(report.importer.manifestChecksum).toBeNull();
    expect(report.nx.projectGraph).toEqual(unsupported);
    expect(report.nx.resolvedProjects.map((entry) => entry.name)).toEqual(["app", "util"]);
    expect(report.failures).toEqual([
      {
        stage: "graph",
        subject: "nx graph --file",
        message: "Unsupported Nx graph shape: dependency edge for app does not declare matching source and target.",
      },
    ]);
    await expect(readManifest(workspaceRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes only the report when no target converts, because strict v1 needs one task", async () => {
    const workspaceRoot = await createWorkspace();
    const onlyOpaque = {
      name: "app",
      root: "apps/app",
      targets: {
        shell: {
          executor: "nx:run-commands",
          options: { command: "npm test && npm run typecheck" },
        },
      },
    };

    await expect(
      importNxTestingWorkspace({
        workspaceRoot,
        expectedGitSha: fixtureSha,
        runner: nxFixtureRunner(workspaceRoot, { app: onlyOpaque }),
      }),
    ).rejects.toThrow("No standalone Nx tasks were convertible; see dads.testing.import-report.json.");

    const report = await readReport(workspaceRoot);
    expect(report.importer.manifestChecksum).toBeNull();
    expect(report.summary).toEqual({
      projects: 2,
      targets: 1,
      converted: 0,
      excluded: 1,
    });
    expect(report.failures.at(-1)).toEqual({
      stage: "conversion",
      subject: "manifest",
      message:
        "No standalone tasks were convertible; no dads.testing.json was written because strict v1 manifests require at least one task.",
    });
    await expect(readManifest(workspaceRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

async function readReport(workspaceRoot: string): Promise<NxImportReport> {
  const contents = await readFile(path.join(workspaceRoot, "dads.testing.import-report.json"), "utf8");
  const parsed: unknown = JSON.parse(contents);
  if (!isImportReport(parsed)) throw new Error("The import report is not the shape this package writes.");
  return parsed;
}

function isImportReport(value: unknown): value is NxImportReport {
  return typeof value === "object" && value !== null && "importer" in value;
}

async function readManifest(workspaceRoot: string): Promise<string> {
  return readFile(path.join(workspaceRoot, "dads.testing.json"), "utf8");
}

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "dads-testing-import-nx-"));
  await mkdir(path.join(workspaceRoot, "node_modules/nx/bin"), {
    recursive: true,
  });
  await writeFile(
    path.join(workspaceRoot, "node_modules/nx/package.json"),
    JSON.stringify({ name: "nx", bin: { nx: "./bin/nx.js" } }),
  );
  await mkdir(path.join(workspaceRoot, "apps/app"), { recursive: true });
  await mkdir(path.join(workspaceRoot, "libs/util"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "node_modules/nx/bin/nx.js"), "// fixture local Nx CLI\n");
  await writeFile(path.join(workspaceRoot, "package-lock.json"), '{"lockfileVersion":3}\n');
  await writeFile(path.join(workspaceRoot, "package.json"), '{"name":"fixture"}\n');
  await writeFile(
    path.join(workspaceRoot, "nx.json"),
    '{"plugins":["@nx/vite/plugin",{"plugin":"@nx/eslint/plugin","options":{"quiet":true}}]}\n',
  );
  await writeFile(
    path.join(workspaceRoot, "apps/app/vite.config.ts"),
    "import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';\n",
  );
  return workspaceRoot;
}

/** What the fixture Nx answers with; each override replaces one answer. */
type FixtureOverrides = {
  readonly graph?: unknown;
  readonly graphFails?: boolean;
  readonly app?: object;
};

function nxFixtureRunner(workspaceRoot: string, overrides: FixtureOverrides = {}): NxCommandRunner {
  return async ({ executable, args, cwd }) => {
    if (executable === "git" && args[0] === "status") return { stdout: "", stderr: "" };
    if (executable === "git" && args[0] === "rev-parse") return { stdout: `${fixtureSha}\n`, stderr: "" };
    if (executable === "npm") return { stdout: "11.19.0\n", stderr: "" };
    if (args[0] === "--version") return { stdout: "v22.20.0\n", stderr: "" };
    if (args[1] === "--version") return { stdout: "Nx: 21.0.0\n", stderr: "" };
    if (args.includes("show") && args.includes("projects")) return { stdout: '["app","util"]\n', stderr: "" };
    if (args.includes("show") && args.includes("project"))
      return {
        stdout: JSON.stringify(
          args.includes("app") ? (overrides.app ?? appProjectDefinition()) : utilProjectDefinition(),
        ),
        stderr: "",
      };
    if (args.includes("graph")) {
      if (overrides.graphFails === true) throw new Error("nx graph exited 1: daemon unavailable");
      const destination = args.find((argument) => argument.startsWith("--file="));
      if (!destination) throw new Error("Fixture graph command was missing --file.");
      await writeFile(
        path.join(cwd, destination.slice("--file=".length)),
        JSON.stringify(overrides.graph ?? supportedGraph()),
      );
      return { stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected fixture command ${executable} ${args.join(" ")} in ${cwd}; expected ${workspaceRoot}.`);
  };
}

function supportedGraph(): unknown {
  return {
    graph: {
      nodes: { app: { name: "app" }, util: { name: "util" } },
      dependencies: {
        app: [{ source: "app", target: "util", type: "static" }],
        util: [],
      },
    },
  };
}

const fixtureSha = "0123456789abcdef0123456789abcdef01234567";

function appProjectDefinition(): object {
  return {
    name: "app",
    root: "apps/app",
    targets: {
      test: {
        executor: "nx:run-commands",
        options: {
          command: "node tools/test.mjs --label 'hello world'",
          cwd: "{projectRoot}",
        },
      },
      lint: { executor: "@nx/eslint:lint" },
      vite: {
        executor: "nx:run-commands",
        options: {
          command: "vitest --config vite.config.ts",
          cwd: "{projectRoot}",
        },
      },
      watch: {
        executor: "nx:run-commands",
        continuous: true,
        options: { command: "node tools/watch.mjs" },
      },
      shell: {
        executor: "nx:run-commands",
        options: { command: "npm test && npm run typecheck" },
      },
    },
  };
}

function utilProjectDefinition(): object {
  return { name: "util", root: "libs/util", targets: {} };
}
