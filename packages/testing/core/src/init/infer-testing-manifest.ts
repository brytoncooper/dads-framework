import type {
  TestingManifest,
  TestingManifestImpactMode,
  TestingManifestProject,
  TestingManifestTask,
  TestingManifestTaskKind,
} from "../testing-manifest.js";
import type { DetectedWorkspace } from "./detect-workspace.js";
import {
  compareText,
  identifyProjects,
  inferOnePackage,
  skippedReportPackage,
  type IdentifiedProjects,
} from "./infer-one-package.js";
import type { WorkspacePackage } from "./package-inventory.js";
import type { ProjectIdSource } from "./project-ids.js";

/**
 * Turns what was detected into the manifest and the report, without touching
 * the file system. Everything the generator concluded is recorded as an
 * inference, and everything it could not read is recorded as unsupported, so
 * the report answers "why does my manifest look like this?" on its own.
 */

export type InitInferenceKind =
  | "package-manager"
  | "workspace-pattern"
  | "root-package"
  | "project-id"
  | "task"
  | "depends-on"
  | "fallback-dependency";

export type InitInference = {
  readonly kind: InitInferenceKind;
  readonly subject: string;
  readonly detail: string;
};

export type InitUnsupported = {
  readonly subject: string;
  readonly message: string;
};

export type InitSkipReason = "no-recognized-scripts" | "invalid-package-json";

export type InitReportTask = {
  readonly id: string;
  readonly script: string;
  readonly kind: TestingManifestTaskKind;
  readonly impactMode: TestingManifestImpactMode;
};

export type InitReportPackage = {
  readonly directory: string;
  readonly name?: string;
  readonly projectId?: string;
  readonly projectIdSource?: ProjectIdSource;
  readonly tasks: readonly InitReportTask[];
  readonly skipped?: InitSkipReason;
};

export type InitValidation = {
  readonly method: "native" | "structural" | "none";
  readonly ok: boolean;
  readonly messages: readonly string[];
  readonly selectedTaskCount?: number;
};

export type InitReport = {
  readonly schemaVersion: 1;
  readonly generator: {
    readonly name: "@dads-framework/testing";
    readonly command: "dad-test init";
  };
  readonly workspace: Pick<
    DetectedWorkspace,
    "packageManager" | "packageManagerSource" | "patternSource" | "patterns" | "ignoredWorkspaceKeys"
  >;
  readonly packages: readonly InitReportPackage[];
  readonly inferences: readonly InitInference[];
  readonly unsupported: readonly InitUnsupported[];
  readonly validation: InitValidation;
  readonly manifestChecksum: string | null;
};

export type InferredTesting = {
  readonly manifest: TestingManifest | undefined;
  readonly report: Omit<InitReport, "validation" | "manifestChecksum">;
};

/** What the packages contributed, before any of it is ordered. */
type InferredPackages = {
  readonly projects: readonly TestingManifestProject[];
  readonly tasks: readonly TestingManifestTask[];
  readonly reportPackages: readonly InitReportPackage[];
};

export function inferTestingManifest(
  workspace: DetectedWorkspace,
  packages: readonly WorkspacePackage[],
): InferredTesting {
  const inferences = workspaceInferences(workspace);
  const identified = identifyProjects(packages);
  const inferred = inferPackages(workspace, packages, identified, inferences);

  const sortedTasks = [...inferred.tasks].sort((left, right) => compareText(left.id, right.id));
  const report: Omit<InitReport, "validation" | "manifestChecksum"> = {
    schemaVersion: 1,
    generator: { name: "@dads-framework/testing", command: "dad-test init" },
    workspace: {
      packageManager: workspace.packageManager,
      packageManagerSource: workspace.packageManagerSource,
      patternSource: workspace.patternSource,
      patterns: workspace.patterns,
      ignoredWorkspaceKeys: workspace.ignoredWorkspaceKeys,
    },
    packages: inferred.reportPackages,
    inferences,
    unsupported: [...workspace.unsupported, ...packages.flatMap((workspacePackage) => workspacePackage.unsupported)],
  };

  if (sortedTasks.length === 0) return { manifest: undefined, report };
  return {
    manifest: {
      schemaVersion: 1,
      workspace: {
        root: ".",
        fullFallback: { taskIds: sortedTasks.map((task) => task.id) },
      },
      projects: [...inferred.projects].sort((left, right) => compareText(left.id, right.id)),
      tasks: sortedTasks,
    },
    report,
  };
}

/** What the workspace itself explains: how scripts run, and where packages were sought. */
function workspaceInferences(workspace: DetectedWorkspace): InitInference[] {
  const inferences: InitInference[] = [
    {
      kind: "package-manager",
      subject: workspace.packageManager,
      detail:
        workspace.packageManagerSource === "default"
          ? "no lockfile was found; scripts run with npm"
          : `from ${workspace.packageManagerSource}`,
    },
  ];
  for (const pattern of workspace.patterns) {
    inferences.push({
      kind: "workspace-pattern",
      subject: pattern,
      detail: `from ${workspace.patternSource}`,
    });
  }
  if (workspace.patternSource === "single-package") {
    inferences.push({
      kind: "root-package",
      subject: ".",
      detail: "no workspace patterns were declared; the root is the package",
    });
  }
  return inferences;
}

/** Every package reaches the report, whether or not it became a project. */
function inferPackages(
  workspace: DetectedWorkspace,
  packages: readonly WorkspacePackage[],
  identified: IdentifiedProjects,
  inferences: InitInference[],
): InferredPackages {
  const projects: TestingManifestProject[] = [];
  const tasks: TestingManifestTask[] = [];
  const reportPackages: InitReportPackage[] = [];

  for (const workspacePackage of packages) {
    const assignment = identified.idByDirectory.get(workspacePackage.directory);
    if (assignment === undefined) {
      reportPackages.push(skippedReportPackage(workspacePackage));
      continue;
    }
    const inferred = inferOnePackage({
      packageManager: workspace.packageManager,
      workspacePackage,
      assignment,
      identified,
      inferences,
    });
    projects.push(inferred.project);
    tasks.push(...inferred.tasks);
    reportPackages.push(inferred.reportPackage);
  }
  return { projects, tasks, reportPackages };
}
