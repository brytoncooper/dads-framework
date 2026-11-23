import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  TestingManifest,
  TestingManifestFileNarrowing,
  TestingManifestProject,
  TestingManifestTask,
} from "../testing-manifest.js";
import {
  buildSubProjects,
  discoverTestsInRoot,
  integrationSuffixes,
  readDadsProjectPackages,
  setupCandidates,
  unitSuffixes,
  type DeclaredDadsPackage,
  type DiscoveredTests,
} from "./dads-app-discovery.js";
import type { DetectedWorkspace } from "./detect-workspace.js";
import { compareText } from "./infer-one-package.js";
import type {
  InferredTesting,
  InitInference,
  InitReportPackage,
  InitReportTask,
  InitUnsupported,
} from "./infer-testing-manifest.js";
import type { WorkspacePackage } from "./package-inventory.js";
import { assignProjectIds, type ProjectIdAssignment } from "./project-ids.js";

/**
 * Infers a domain-aware manifest for a single-package Dads application that
 * declares `dads.project.json` and runs Vitest. Each declared package root
 * becomes a manifest project with file-level Vitest narrowing, while the root
 * project owns shared app files and root test directories (`tests/`).
 */

export function inferDadsAppManifest(
  workspaceRoot: string,
  workspace: DetectedWorkspace,
  packages: readonly WorkspacePackage[],
): InferredTesting | undefined {
  const rootPackage = eligibleRootPackage(workspace, packages);
  if (rootPackage === undefined) return undefined;

  const declared = readDadsProjectPackages(workspaceRoot);
  if (declared === undefined || declared.length === 0) return undefined;

  const idByRoot = assignDadsProjectIds(rootPackage, declared);
  const rootAssignment = idByRoot.get(".");
  if (rootAssignment === undefined) return undefined;

  const inferences = initialInferences(workspace);
  const projects = buildAllProjects(declared, rootAssignment.projectId, idByRoot, inferences);
  const built = buildAllTasks({
    workspaceRoot,
    workspace,
    rootPackage,
    rootProjectId: rootAssignment.projectId,
    declared,
    projects,
    inferences,
  });
  if (built.tasks.length === 0) return undefined;

  return assembleInferredTesting({
    workspace,
    rootPackage,
    projects,
    tasks: built.tasks,
    reportTasksByRoot: built.reportTasksByRoot,
    idByRoot,
    inferences,
  });
}

function eligibleRootPackage(
  workspace: DetectedWorkspace,
  packages: readonly WorkspacePackage[],
): WorkspacePackage | undefined {
  if (workspace.patternSource !== "single-package" || packages.length !== 1) return undefined;
  const rootPackage = packages[0];
  if (rootPackage === undefined || !rootPackage.packageJsonReadable || rootPackage.directory !== ".") return undefined;
  const testScript = rootPackage.scripts["test"];
  if (testScript === undefined || !/\bvitest\b/.test(testScript)) return undefined;
  return rootPackage;
}

function assignDadsProjectIds(
  rootPackage: WorkspacePackage,
  declared: readonly DeclaredDadsPackage[],
): ReadonlyMap<string, ProjectIdAssignment> {
  const assignments = assignProjectIds([
    rootPackage,
    ...declared.map((entry): WorkspacePackage => ({
      directory: entry.root,
      name: entry.name,
      scripts: {},
      workspaceDependencies: [],
      tsconfigReferences: [],
      packageJsonReadable: true,
      unsupported: [],
    })),
  ]);
  return new Map(assignments.map((entry) => [entry.directory, entry]));
}

function initialInferences(workspace: DetectedWorkspace): InitInference[] {
  return [
    {
      kind: "package-manager",
      subject: workspace.packageManager,
      detail:
        workspace.packageManagerSource === "default"
          ? "no lockfile was found; scripts run with npm"
          : `from ${workspace.packageManagerSource}`,
    },
    {
      kind: "root-package",
      subject: ".",
      detail: "inferred Dads application domains and Vitest file narrowing from dads.project.json",
    },
  ];
}

function buildAllProjects(
  declared: readonly DeclaredDadsPackage[],
  rootProjectId: string,
  idByRoot: ReadonlyMap<string, ProjectIdAssignment>,
  inferences: InitInference[],
): readonly TestingManifestProject[] {
  const subProjects = buildSubProjects(declared, idByRoot, inferences);
  const rootProject: TestingManifestProject = {
    id: rootProjectId,
    root: ".",
    fallbackDependencies: subProjects.map((project) => project.id).sort(compareText),
  };
  return [rootProject, ...subProjects].sort((left, right) => compareText(left.id, right.id));
}

function buildAllTasks(input: {
  readonly workspaceRoot: string;
  readonly workspace: DetectedWorkspace;
  readonly rootPackage: WorkspacePackage;
  readonly rootProjectId: string;
  readonly declared: readonly DeclaredDadsPackage[];
  readonly projects: readonly TestingManifestProject[];
  readonly inferences: InitInference[];
}): {
  readonly tasks: readonly TestingManifestTask[];
  readonly reportTasksByRoot: ReadonlyMap<string, readonly InitReportTask[]>;
} {
  const setupFiles = setupCandidates.filter((candidate) => existsSync(join(input.workspaceRoot, candidate)));
  const subRoots = new Set(input.declared.map((entry) => entry.root));
  const tasks: TestingManifestTask[] = [];
  const reportTasksByRoot = new Map<string, InitReportTask[]>();
  const typecheckTaskId = appendTypecheckTask(input, tasks, reportTasksByRoot);

  for (const project of input.projects) {
    const excluded = project.root === "." ? subRoots : new Set<string>();
    const discovered = discoverTestsInRoot(input.workspaceRoot, project.root, excluded);
    appendProjectTestTasks({
      project,
      discovered,
      setupFiles,
      typecheckTaskId,
      tasks,
      reportTasksByRoot,
      inferences: input.inferences,
    });
  }
  return {
    tasks: [...tasks].sort((left, right) => compareText(left.id, right.id)),
    reportTasksByRoot,
  };
}

function appendTypecheckTask(
  input: {
    readonly workspace: DetectedWorkspace;
    readonly rootPackage: WorkspacePackage;
    readonly rootProjectId: string;
    readonly inferences: InitInference[];
  },
  tasks: TestingManifestTask[],
  reportTasksByRoot: Map<string, InitReportTask[]>,
): string | undefined {
  if (input.rootPackage.scripts["typecheck"] === undefined) return undefined;
  const id = `${input.rootProjectId}:typecheck`;
  tasks.push({
    id,
    project: input.rootProjectId,
    kind: "typecheck",
    execution: { executable: input.workspace.packageManager, args: ["run", "typecheck"] },
    dependsOn: [],
    impact: { mode: "reachability", paths: [] },
  });
  pushReportTask(reportTasksByRoot, ".", { id, script: "typecheck", kind: "typecheck", impactMode: "reachability" });
  input.inferences.push({ kind: "task", subject: id, detail: `${input.workspace.packageManager} run typecheck in .` });
  return id;
}

function appendProjectTestTasks(input: {
  readonly project: TestingManifestProject;
  readonly discovered: DiscoveredTests;
  readonly setupFiles: readonly string[];
  readonly typecheckTaskId: string | undefined;
  readonly tasks: TestingManifestTask[];
  readonly reportTasksByRoot: Map<string, InitReportTask[]>;
  readonly inferences: InitInference[];
}): void {
  const variants: readonly ("unit" | "integration")[] = [
    ...(input.discovered.hasUnit ? (["unit"] as const) : []),
    ...(input.discovered.hasIntegration ? (["integration"] as const) : []),
  ];
  for (const variant of variants) {
    const task = buildVitestTask({
      projectId: input.project.id,
      root: input.project.root,
      variant,
      setupFiles: input.setupFiles,
      typecheckTaskId: input.typecheckTaskId,
    });
    input.tasks.push(task);
    pushReportTask(input.reportTasksByRoot, input.project.root, {
      id: task.id,
      script: "test",
      kind: "test",
      impactMode: "reachability",
    });
    input.inferences.push({
      kind: "task",
      subject: task.id,
      detail: `npx ${task.execution.args.join(" ")} with file-level narrowing`,
    });
  }
}

function assembleInferredTesting(input: {
  readonly workspace: DetectedWorkspace;
  readonly rootPackage: WorkspacePackage;
  readonly projects: readonly TestingManifestProject[];
  readonly tasks: readonly TestingManifestTask[];
  readonly reportTasksByRoot: ReadonlyMap<string, readonly InitReportTask[]>;
  readonly idByRoot: ReadonlyMap<string, ProjectIdAssignment>;
  readonly inferences: readonly InitInference[];
}): InferredTesting {
  const reportPackages: InitReportPackage[] = input.projects.map((project) => {
    const assignment = input.idByRoot.get(project.root);
    return {
      directory: project.root,
      ...(project.root === "." && input.rootPackage.name !== undefined ? { name: input.rootPackage.name } : {}),
      projectId: project.id,
      ...(assignment === undefined ? {} : { projectIdSource: assignment.source }),
      tasks: input.reportTasksByRoot.get(project.root) ?? [],
    };
  });
  const unsupported: InitUnsupported[] = [...input.workspace.unsupported, ...input.rootPackage.unsupported];
  const manifest: TestingManifest = {
    schemaVersion: 1,
    workspace: { root: ".", fullFallback: { taskIds: input.tasks.map((task) => task.id) } },
    projects: input.projects,
    tasks: input.tasks,
  };
  return {
    manifest,
    report: {
      schemaVersion: 1,
      generator: { name: "@dads-framework/testing", command: "dad-test init" },
      workspace: {
        packageManager: input.workspace.packageManager,
        packageManagerSource: input.workspace.packageManagerSource,
        patternSource: input.workspace.patternSource,
        patterns: input.workspace.patterns,
        ignoredWorkspaceKeys: input.workspace.ignoredWorkspaceKeys,
      },
      packages: reportPackages,
      inferences: input.inferences,
      unsupported,
    },
  };
}

function buildVitestTask(input: {
  readonly projectId: string;
  readonly root: string;
  readonly variant: "unit" | "integration";
  readonly setupFiles: readonly string[];
  readonly typecheckTaskId: string | undefined;
}): TestingManifestTask {
  const args = ["vitest", "run"];
  if (input.root !== ".") args.push("--dir", input.root);
  if (input.variant === "unit") {
    args.push("--exclude", "**/*.integration.test.*", "--exclude", "**/*.integration.spec.*");
  }
  const fileNarrowing: TestingManifestFileNarrowing = {
    suffixes: input.variant === "unit" ? unitSuffixes : integrationSuffixes,
    ...(input.variant === "unit" ? { excludeSuffixes: integrationSuffixes } : {}),
    ...(input.setupFiles.length === 0 ? {} : { setupFiles: input.setupFiles }),
  };
  return {
    id: `${input.projectId}:${input.variant}`,
    project: input.projectId,
    kind: "test",
    execution: { executable: "npx", args, fileNarrowing },
    dependsOn: input.typecheckTaskId === undefined ? [] : [input.typecheckTaskId],
    impact: { mode: "reachability", paths: [] },
  };
}

function pushReportTask(map: Map<string, InitReportTask[]>, root: string, task: InitReportTask): void {
  const existing = map.get(root);
  if (existing === undefined) map.set(root, [task]);
  else existing.push(task);
}
