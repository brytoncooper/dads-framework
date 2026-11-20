import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseTestingManifest,
  type TestingManifest,
} from "../testing-manifest.js";
import { checkTestingManifest } from "./check-testing-manifest.js";

const repositoryRoot = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
);

function validManifest(): TestingManifest {
  return {
    schemaVersion: 1,
    workspace: {
      root: ".",
      fullFallback: { taskIds: ["core:typecheck", "core:test"] },
    },
    projects: [
      { id: "core", root: "packages/core", fallbackDependencies: [] },
      { id: "api", root: "apps/api", fallbackDependencies: ["core"] },
    ],
    tasks: [
      {
        id: "core:typecheck",
        project: "core",
        kind: "typecheck",
        execution: { executable: "npm", args: ["run", "typecheck"] },
        dependsOn: [],
        impact: { mode: "project", paths: [] },
      },
      {
        id: "core:test",
        project: "core",
        kind: "test",
        execution: {
          executable: "npm",
          args: ["run", "test"],
          cwd: "packages/core",
        },
        dependsOn: ["core:typecheck"],
        impact: { mode: "reachability", paths: [] },
      },
    ],
  };
}

describe("generated manifest checking", () => {
  it("accepts a manifest the native engine accepts", () => {
    expect(checkTestingManifest(validManifest())).toEqual([]);
  });

  const violations: readonly {
    readonly name: string;
    readonly break: (manifest: TestingManifest) => TestingManifest;
    readonly message: string;
  }[] = [
    {
      name: "an empty workspace root",
      break: (manifest) => ({
        ...manifest,
        workspace: { ...manifest.workspace, root: " " },
      }),
      message: "workspace.root must not be empty.",
    },
    {
      name: "a workspace root outside the workspace",
      break: (manifest) => ({
        ...manifest,
        workspace: { ...manifest.workspace, root: "../elsewhere" },
      }),
      message:
        "workspace.root must be a workspace-relative path without parent traversal.",
    },
    {
      name: "a project id outside the identifier charset",
      break: (manifest) =>
        withProject(manifest, (project) => ({ ...project, id: "core/api" })),
      message: "project id must use letters, numbers, -, _, ., or :.",
    },
    {
      name: "an empty project id",
      break: (manifest) =>
        withProject(manifest, (project) => ({ ...project, id: "" })),
      message: "project id must use letters, numbers, -, _, ., or :.",
    },
    {
      name: "two projects with the same id",
      break: (manifest) => ({
        ...manifest,
        projects: [
          ...manifest.projects,
          { id: "core", root: "apps/other", fallbackDependencies: [] },
        ],
      }),
      message: "Duplicate project id core.",
    },
    {
      name: "an empty project root",
      break: (manifest) =>
        withProject(manifest, (project) => ({ ...project, root: "" })),
      message: "project.root must not be empty.",
    },
    {
      name: "a project root above the workspace",
      break: (manifest) =>
        withProject(manifest, (project) => ({
          ...project,
          root: "../packages/core",
        })),
      message:
        "project.root must be a workspace-relative path without parent traversal.",
    },
    {
      name: "a project that falls back to itself",
      break: (manifest) =>
        withProject(manifest, (project) => ({
          ...project,
          fallbackDependencies: ["core"],
        })),
      message: "Project core cannot fallback-depend on itself.",
    },
    {
      name: "a fallback dependency no project declares",
      break: (manifest) =>
        withProject(manifest, (project) => ({
          ...project,
          fallbackDependencies: ["ghost"],
        })),
      message: "Project core references unknown fallback dependency ghost.",
    },
    {
      name: "a task id outside the identifier charset",
      break: (manifest) => withTaskId(manifest, "core/test"),
      message: "task id must use letters, numbers, -, _, ., or :.",
    },
    {
      name: "two tasks with the same id",
      break: (manifest) => ({
        ...manifest,
        workspace: {
          ...manifest.workspace,
          fullFallback: { taskIds: ["core:typecheck", "core:test"] },
        },
        tasks: [...manifest.tasks, lastTask(manifest)],
      }),
      message: "Duplicate task id core:test.",
    },
    {
      name: "a task in a project no manifest declares",
      break: (manifest) =>
        withTask(manifest, (task) => ({ ...task, project: "ghost" })),
      message: "Task core:test references unknown project ghost.",
    },
    {
      name: "a task with a blank executable",
      break: (manifest) =>
        withTask(manifest, (task) => ({
          ...task,
          execution: { ...task.execution, executable: "  " },
        })),
      message: "Task core:test is missing execution.executable.",
    },
    {
      name: "a working directory above the workspace",
      break: (manifest) =>
        withTask(manifest, (task) => ({
          ...task,
          execution: { ...task.execution, cwd: "../packages/core" },
        })),
      message:
        "execution.cwd must be a workspace-relative path without parent traversal.",
    },
    {
      name: "an impact path above the workspace",
      break: (manifest) =>
        withTask(manifest, (task) => ({
          ...task,
          impact: { mode: "changed-files", paths: ["../shared"] },
        })),
      message:
        "impact.paths must be a workspace-relative path without parent traversal.",
    },
    {
      name: "changed-files impact without paths",
      break: (manifest) =>
        withTask(manifest, (task) => ({
          ...task,
          impact: { mode: "changed-files", paths: [] },
        })),
      message: "Task core:test uses changed-files impact without paths.",
    },
    {
      name: "a task that depends on itself",
      break: (manifest) =>
        withTask(manifest, (task) => ({ ...task, dependsOn: ["core:test"] })),
      message: "Task core:test cannot depend on itself.",
    },
    {
      name: "a dependency no task declares",
      break: (manifest) =>
        withTask(manifest, (task) => ({ ...task, dependsOn: ["ghost"] })),
      message: "Task core:test references unknown dependency ghost.",
    },
    {
      name: "a dependency cycle",
      break: (manifest) => ({
        ...manifest,
        tasks: manifest.tasks.map((task) =>
          task.id === "core:typecheck"
            ? { ...task, dependsOn: ["core:test"] }
            : task,
        ),
      }),
      message: "Task dependency cycle includes core:typecheck.",
    },
    {
      name: "a repeated full-fallback task id",
      break: (manifest) => ({
        ...manifest,
        workspace: {
          ...manifest.workspace,
          fullFallback: {
            taskIds: ["core:typecheck", "core:test", "core:test"],
          },
        },
      }),
      message: "fullFallback.taskIds contains duplicate task ids.",
    },
    {
      name: "a full fallback that omits a task",
      break: (manifest) => ({
        ...manifest,
        workspace: {
          ...manifest.workspace,
          fullFallback: { taskIds: ["core:typecheck"] },
        },
      }),
      message:
        "workspace.fullFallback.taskIds must contain every declared task exactly once.",
    },
    {
      name: "a manifest without tasks",
      break: (manifest) => ({
        ...manifest,
        workspace: { ...manifest.workspace, fullFallback: { taskIds: [] } },
        tasks: [],
      }),
      message: "Manifest must declare at least one task.",
    },
  ];

  for (const violation of violations) {
    it(`reports ${violation.name}`, () => {
      expect(checkTestingManifest(violation.break(validManifest()))).toContain(
        violation.message,
      );
    });
  }

  const fixtures = [
    "fixtures/testing/dads.testing.json",
    "fixtures/testing-soundness/dads.testing.json",
  ];

  for (const fixture of fixtures) {
    it(`accepts ${fixture}`, () => {
      const manifest = parseTestingManifest(
        readFileSync(join(repositoryRoot, fixture), "utf8"),
        fixture,
      );

      expect(checkTestingManifest(manifest)).toEqual([]);
    });
  }
});

function withProject(
  manifest: TestingManifest,
  change: (
    project: TestingManifest["projects"][number],
  ) => TestingManifest["projects"][number],
): TestingManifest {
  return {
    ...manifest,
    projects: manifest.projects.map((project) =>
      project.id === "core" ? change(project) : project,
    ),
  };
}

function withTask(
  manifest: TestingManifest,
  change: (
    task: TestingManifest["tasks"][number],
  ) => TestingManifest["tasks"][number],
): TestingManifest {
  return {
    ...manifest,
    tasks: manifest.tasks.map((task) =>
      task.id === "core:test" ? change(task) : task,
    ),
  };
}

function withTaskId(manifest: TestingManifest, id: string): TestingManifest {
  return {
    ...manifest,
    workspace: {
      ...manifest.workspace,
      fullFallback: { taskIds: ["core:typecheck", id] },
    },
    tasks: manifest.tasks.map((task) =>
      task.id === "core:test" ? { ...task, id } : task,
    ),
  };
}

function lastTask(manifest: TestingManifest): TestingManifest["tasks"][number] {
  const task = manifest.tasks[manifest.tasks.length - 1];
  if (task === undefined) throw new Error("The fixture declares no tasks.");
  return task;
}
