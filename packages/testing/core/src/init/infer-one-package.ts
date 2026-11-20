import type {
  TestingManifestImpactMode,
  TestingManifestProject,
  TestingManifestTask,
  TestingManifestTaskKind,
} from "../testing-manifest.js";
import type {
  InitInference,
  InitReportPackage,
  InitReportTask,
} from "./infer-testing-manifest.js";
import type { WorkspacePackage } from "./package-inventory.js";
import { assignProjectIds, type ProjectIdAssignment } from "./project-ids.js";

/**
 * What one workspace package contributes to the manifest: the project it
 * becomes, the tasks its scripts become, and the report entry explaining both.
 * Every conclusion is recorded as an inference where it is drawn, so the report
 * reads in the order the generator worked.
 */

export type RecognizedScript = {
  readonly script: string;
  readonly kind: TestingManifestTaskKind;
  readonly impactMode: TestingManifestImpactMode;
};

/** The project ids in play, looked up the two ways a dependency edge can name one. */
export type IdentifiedProjects = {
  readonly idByDirectory: ReadonlyMap<string, ProjectIdAssignment>;
  readonly idByPackageName: ReadonlyMap<string, string>;
};

export type InferredPackage = {
  readonly project: TestingManifestProject;
  readonly tasks: readonly TestingManifestTask[];
  readonly reportPackage: InitReportPackage;
};

type InferredTask = {
  readonly task: TestingManifestTask;
  readonly reportTask: InitReportTask;
};

/**
 * Only the four scripts every workspace already agrees on. A test run is scoped
 * by reachability because a test exercises code it imports; the others are
 * scoped to their project because they read the whole project either way.
 */
const recognizedScripts: readonly RecognizedScript[] = [
  { script: "test", kind: "test", impactMode: "reachability" },
  { script: "typecheck", kind: "typecheck", impactMode: "project" },
  { script: "lint", kind: "lint", impactMode: "project" },
  { script: "build", kind: "build", impactMode: "project" },
];

export function recognizedScriptsOf(
  workspacePackage: WorkspacePackage,
): readonly RecognizedScript[] {
  return recognizedScripts.filter(
    (recognized) => workspacePackage.scripts[recognized.script] !== undefined,
  );
}

/**
 * Only a package that declares a recognized script becomes a project, so an id
 * is assigned to exactly the packages that will carry tasks.
 */
export function identifyProjects(
  packages: readonly WorkspacePackage[],
): IdentifiedProjects {
  const projectPackages = packages.filter(
    (workspacePackage) =>
      workspacePackage.packageJsonReadable &&
      recognizedScriptsOf(workspacePackage).length > 0,
  );
  const assignments = assignProjectIds(projectPackages);
  const idByDirectory = new Map(
    assignments.map((assignment) => [assignment.directory, assignment]),
  );
  const idByPackageName = new Map<string, string>();
  for (const workspacePackage of projectPackages) {
    const assignment = idByDirectory.get(workspacePackage.directory);
    if (workspacePackage.name === undefined || assignment === undefined) {
      continue;
    }
    idByPackageName.set(workspacePackage.name, assignment.projectId);
  }
  return { idByDirectory, idByPackageName };
}

/** A package that was assigned no id declares no tasks; the report says which reason. */
export function skippedReportPackage(
  workspacePackage: WorkspacePackage,
): InitReportPackage {
  return {
    directory: workspacePackage.directory,
    ...(workspacePackage.name === undefined
      ? {}
      : { name: workspacePackage.name }),
    tasks: [],
    skipped: workspacePackage.packageJsonReadable
      ? "no-recognized-scripts"
      : "invalid-package-json",
  };
}

export function inferOnePackage(request: {
  readonly packageManager: string;
  readonly workspacePackage: WorkspacePackage;
  readonly assignment: ProjectIdAssignment;
  readonly identified: IdentifiedProjects;
  readonly inferences: InitInference[];
}): InferredPackage {
  const { workspacePackage, assignment, inferences } = request;
  const projectId = assignment.projectId;
  inferences.push({
    kind: "project-id",
    subject: projectId,
    detail:
      assignment.source === "package-name"
        ? `from the package name ${workspacePackage.name ?? projectId}`
        : `from the directory ${workspacePackage.directory}`,
  });

  const declared = recognizedScriptsOf(workspacePackage);
  const scriptNames = new Set(declared.map((entry) => entry.script));
  const inferred = declared.map((recognized) =>
    inferOneTask({
      packageManager: request.packageManager,
      directory: workspacePackage.directory,
      projectId,
      recognized,
      dependsOnTypecheck:
        recognized.script === "test" && scriptNames.has("typecheck"),
      inferences,
    }),
  );

  const fallbackDependencies = fallbackDependenciesOf(
    workspacePackage,
    projectId,
    request.identified,
    inferences,
  );
  return {
    project: {
      id: projectId,
      root: workspacePackage.directory,
      fallbackDependencies,
    },
    tasks: inferred.map((entry) => entry.task),
    reportPackage: {
      directory: workspacePackage.directory,
      ...(workspacePackage.name === undefined
        ? {}
        : { name: workspacePackage.name }),
      projectId,
      projectIdSource: assignment.source,
      tasks: inferred.map((entry) => entry.reportTask),
    },
  };
}

/** A test runs after its own project's typecheck, when the project declares one. */
function inferOneTask(request: {
  readonly packageManager: string;
  readonly directory: string;
  readonly projectId: string;
  readonly recognized: RecognizedScript;
  readonly dependsOnTypecheck: boolean;
  readonly inferences: InitInference[];
}): InferredTask {
  const { projectId, recognized, directory, inferences } = request;
  const taskId = `${projectId}:${recognized.script}`;
  const dependsOn = request.dependsOnTypecheck
    ? [`${projectId}:typecheck`]
    : [];
  const task: TestingManifestTask = {
    id: taskId,
    project: projectId,
    kind: recognized.kind,
    execution: {
      executable: request.packageManager,
      args: ["run", recognized.script],
      ...(directory === "." ? {} : { cwd: directory }),
    },
    dependsOn,
    impact: { mode: recognized.impactMode, paths: [] },
  };
  inferences.push({
    kind: "task",
    subject: taskId,
    detail: `${request.packageManager} run ${recognized.script} in ${directory}`,
  });
  for (const dependency of dependsOn) {
    inferences.push({
      kind: "depends-on",
      subject: taskId,
      detail: `runs after ${dependency}`,
    });
  }
  return {
    task,
    reportTask: {
      id: taskId,
      script: recognized.script,
      kind: recognized.kind,
      impactMode: recognized.impactMode,
    },
  };
}

/**
 * A project falls back to the projects it declares a dependency on: a package
 * dependency, or a TypeScript project reference. The fallback is what runs when
 * impact cannot be proven, so a missing edge is unsound and an extra edge only
 * costs time.
 */
function fallbackDependenciesOf(
  workspacePackage: WorkspacePackage,
  projectId: string,
  identified: IdentifiedProjects,
  inferences: InitInference[],
): readonly string[] {
  const reasons = new Map<string, string>();
  addPackageDependencyReasons(reasons, workspacePackage, projectId, identified);
  addProjectReferenceReasons(reasons, workspacePackage, projectId, identified);

  const sorted = [...reasons.keys()].sort(compareText);
  for (const dependencyId of sorted) {
    inferences.push({
      kind: "fallback-dependency",
      subject: projectId,
      detail: `${reasons.get(dependencyId) ?? ""}, so it falls back to ${dependencyId}`,
    });
  }
  return sorted;
}

function addPackageDependencyReasons(
  reasons: Map<string, string>,
  workspacePackage: WorkspacePackage,
  projectId: string,
  identified: IdentifiedProjects,
): void {
  for (const name of workspacePackage.workspaceDependencies) {
    const dependencyId = identified.idByPackageName.get(name);
    if (dependencyId === undefined || dependencyId === projectId) continue;
    reasons.set(dependencyId, `declares a dependency on ${name}`);
  }
}

/** A package dependency already explains an edge, so a reference never replaces one. */
function addProjectReferenceReasons(
  reasons: Map<string, string>,
  workspacePackage: WorkspacePackage,
  projectId: string,
  identified: IdentifiedProjects,
): void {
  for (const directory of workspacePackage.tsconfigReferences) {
    const dependencyId = identified.idByDirectory.get(directory)?.projectId;
    if (dependencyId === undefined || dependencyId === projectId) continue;
    if (reasons.has(dependencyId)) continue;
    reasons.set(
      dependencyId,
      `references the TypeScript project in ${directory}`,
    );
  }
}

/** Ordering is by code unit so a generated manifest does not depend on a locale. */
export function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}
