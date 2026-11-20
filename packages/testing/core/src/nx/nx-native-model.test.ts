import process from "node:process";
import { describe, expect, it } from "vitest";
import { buildNativeNxManifest } from "./nx-native-model.js";

const nxCli = "/synthetic/node_modules/nx/bin/nx.js";

function graph(targets: Record<string, unknown>) {
  return {
    nodes: {
      harbor: {
        name: "harbor",
        data: { name: "harbor", root: "apps/harbor", targets },
      },
    },
    dependencies: { harbor: [] },
  };
}

function build(
  targets: Record<string, unknown>,
  targetNames?: readonly string[],
) {
  return buildNativeNxManifest({
    graph: graph(targets),
    nxConfiguration: {},
    nxCli,
    ...(targetNames === undefined ? {} : { targetNames }),
  });
}

describe("native Nx manifest inventory", () => {
  it("preserves native argv and configuration ownership while auditing exclusions", () => {
    const result = build({
      test: {
        executor: "vendor:test",
        defaultConfiguration: "ci",
        configurations: { ci: { args: ["--real-option"] } },
        options: { env: { KEEP: "yes" } },
      },
      "typecheck-lib-isolation": { inputs: [{ runtime: "tsc --version" }] },
      "lint-ci": {},
      "test:unit": {},
      build: {},
      publish: {},
      serve: { continuous: true },
      "test:watch": { continuous: true },
    });
    expect(result.coverage).toMatchObject({
      projects: 1,
      targets: 8,
      registered: 5,
      excluded: 3,
      always: 1,
    });
    const task = result.manifest.tasks.find(
      (task) => task.execution.args[3] === "--target=test",
    );
    expect(task?.execution).toEqual({
      executable: process.execPath,
      args: [nxCli, "run", "--project=harbor", "--target=test"],
      cwd: ".",
    });
    expect(task?.dependsOn).toEqual([]);
    expect(task?.impact.mode).toBe("changed-files");
    expect(
      result.coverage.tasks.find(
        (audit) => audit.target === "typecheck-lib-isolation",
      )?.reason,
    ).toContain("non-file or unresolved input");
    expect(result.manifest.workspace.fullFallback.taskIds).toEqual(
      result.manifest.tasks.map((task) => task.id).sort(),
    );
    expect(
      result.coverage.tasks.find((task) => task.target === "publish")?.reason,
    ).toContain("Outside requested");
  });

  it("discovers newly added targets on each build and honors exact scope overrides", () => {
    expect(build({ test: {} }).coverage.registered).toBe(1);
    expect(
      build({ test: {}, "test:integration": {} }).coverage.registered,
    ).toBe(2);
    const explicit = build(
      { test: {}, audit: {}, watch: { continuous: true } },
      ["audit", "watch"],
    );
    expect(explicit.coverage.registered).toBe(1);
    expect(explicit.manifest.tasks[0]?.execution.args[3]).toBe(
      "--target=audit",
    );
    expect(
      explicit.coverage.tasks.find((task) => task.target === "watch")?.reason,
    ).toContain("Continuous");
  });

  it("refuses a graph that registers no verification target at all", () => {
    const nothingRegistered: readonly {
      readonly targets: Record<string, unknown>;
      readonly targetNames?: readonly string[];
    }[] = [
      { targets: {} },
      { targets: { serve: { continuous: true } } },
      { targets: { publish: {} } },
      { targets: { test: {} }, targetNames: ["audit"] },
    ];
    for (const one of nothingRegistered) {
      expect(() => build(one.targets, one.targetNames)).toThrow(
        "No non-continuous verification targets were registered.",
      );
    }
  });

  it("uses reversible IDs for special names without flattening the Nx target identity", () => {
    const result = build({ "test:unit": {} });
    expect(result.manifest.tasks[0]?.id).toBe(
      "nx-68-61-72-62-6f-72:nx-74-65-73-74-3a-75-6e-69-74",
    );
    expect(result.manifest.tasks[0]?.execution.args).toEqual([
      nxCli,
      "run",
      "--project=harbor",
      "--target=test:unit",
    ]);
  });

  it("rejects malformed graph structure and ambiguous project identities", () => {
    for (const invalid of [
      null,
      {},
      { nodes: {}, dependencies: {} },
      { ...graph({ test: {} }), dependencies: {} },
      {
        ...graph({ test: {} }),
        dependencies: { harbor: [{ source: "other", target: "harbor" }] },
      },
      {
        ...graph({ test: {} }),
        dependencies: { harbor: [{ source: "harbor", target: "missing" }] },
      },
      { ...graph({ test: {} }), dependencies: { harbor: [], missing: [] } },
      {
        nodes: {
          harbor: {
            data: { name: "other", root: "apps/harbor", targets: { test: {} } },
          },
        },
        dependencies: { harbor: [] },
      },
    ]) {
      expect(() =>
        buildNativeNxManifest({ graph: invalid, nxConfiguration: {}, nxCli }),
      ).toThrow();
    }
    for (const root of [
      "../outside",
      "/absolute",
      "C:/absolute",
      "apps/../outside",
      "apps\\outside",
    ]) {
      const invalid = graph({ test: {} });
      invalid.nodes.harbor.data.root = root;
      expect(() =>
        buildNativeNxManifest({ graph: invalid, nxConfiguration: {}, nxCli }),
      ).toThrow(/root/);
    }
  });

  it("supports project cycles supported by core while retaining both dependency roots", () => {
    const result = buildNativeNxManifest({
      nxCli,
      nxConfiguration: {},
      graph: {
        nodes: {
          harbor: {
            data: {
              name: "harbor",
              root: "apps/harbor",
              targets: { test: {} },
            },
          },
          shared: {
            data: { name: "shared", root: "libs/shared", targets: {} },
          },
        },
        dependencies: {
          harbor: [{ source: "harbor", target: "shared" }],
          shared: [{ source: "shared", target: "harbor" }],
        },
      },
    });
    expect(result.manifest.tasks[0]?.impact).toEqual({
      mode: "changed-files",
      paths: [
        "apps/harbor",
        "libs/shared",
        "nx.json",
        "package-lock.json",
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "tsconfig.base.json",
        "tsconfig.json",
        "yarn.lock",
      ],
    });
  });

  it("keeps external dependency inputs conservative without inventing projects", () => {
    const result = buildNativeNxManifest({
      nxCli,
      nxConfiguration: {},
      graph: {
        ...graph({ test: {} }),
        externalNodes: {
          "npm:tool": {
            name: "npm:tool",
            type: "npm",
            data: { packageName: "tool" },
          },
        },
        dependencies: {
          harbor: [
            { source: "harbor", target: "npm:tool" },
            { source: "harbor", target: "harbor" },
          ],
        },
      },
    });
    expect(result.manifest.projects).toHaveLength(1);
    expect(result.manifest.projects[0]?.fallbackDependencies).toEqual([]);
    expect(result.manifest.tasks[0]?.impact.mode).toBe("changed-files");
    expect(result.manifest.tasks[0]?.impact.paths).toContain(
      "package-lock.json",
    );
    expect(result.manifest.tasks[0]?.impact.paths).toContain("package.json");
    expect(() =>
      buildNativeNxManifest({
        nxCli,
        nxConfiguration: {},
        graph: {
          ...graph({ test: {} }),
          externalNodes: { "npm:tool": { name: "wrong", data: {} } },
        },
      }),
    ).toThrow(/external Nx node/);
  });
});
