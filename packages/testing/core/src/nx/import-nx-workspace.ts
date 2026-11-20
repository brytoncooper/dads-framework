/**
 * The import, read top to bottom.
 *
 * One Nx workspace becomes two files: a Dads-owned manifest that runs without
 * Nx, and a report that says what was read, what was converted, and what was
 * left behind and why. The phases below run in the order they are written —
 * pin the source tree, read the graph, read the projects, convert the targets,
 * then write — and each of the two shapes Nx can answer in that this importer
 * does not understand ends with a report on disk before the failure is raised,
 * so a refused import is still evidence rather than a stack trace.
 */
import path from "node:path";
import { resolveLocalNxCli } from "./nx-installation.js";
import { writeOutputsAtomically } from "./atomic-output.js";
import { digestInputs, digestProjectInputs, sha256 } from "./import-digest.js";
import type {
  DadsTestingManifest,
  DadsTestingTask,
  DigestedInput,
  DroppedField,
  GitSnapshot,
  ImportedTaskAudit,
  ImportFailure,
  ImportNxTestingOptions,
  ImportNxTestingResult,
  NxCommandRunner,
  NxImportReport,
  NxProject,
  NxProjectSnapshot,
  TargetConversion,
} from "./import-nx-types.js";
import { stableJson, type JsonValue } from "./json-values.js";
import { parseNxGraphFallbackDependencies } from "./nx-graph-fallback.js";
import { convertTarget } from "./nx-target-conversion.js";
import {
  parseProject,
  readNxPlugins,
  readOptionalJson,
  readNxProjectConfiguration,
  readProjects,
  readProjectGraph,
  readVersions,
  relativeLocation,
  requireCleanCommittedWorkspace,
  runProcess,
} from "./nx-workspace-reader.js";

const outputManifestName = "dads.testing.json";
const outputReportName = "dads.testing.import-report.json";

/** The pinned tree, and everything read from it before any project was. */
type NxSource = {
  readonly gitSnapshot: GitSnapshot;
  readonly nxExecutable: string;
  readonly versions: Readonly<Record<string, string>>;
  readonly rootInputs: readonly DigestedInput[];
  readonly plugins: readonly string[];
  readonly projects: readonly string[];
};

/** Every project, as Nx reported it and as this importer understood it. */
type NxWorkspaceProjects = {
  readonly snapshots: readonly NxProjectSnapshot[];
  readonly parsedProjects: readonly NxProject[];
  readonly inputs: readonly DigestedInput[];
};

/** What converting every target of every project produced. */
type ProjectConversion = {
  readonly tasks: readonly DadsTestingTask[];
  readonly audits: readonly ImportedTaskAudit[];
  readonly droppedFields: readonly DroppedField[];
  readonly failures: readonly ImportFailure[];
  readonly executors: readonly string[];
  readonly targetCount: number;
};

/**
 * Imports only fully materialized, shell-free Nx run-commands targets. The
 * output is a Dads-owned manifest; Nx is not read when the manifest executes.
 */
export async function importNxTestingWorkspace(
  options: ImportNxTestingOptions,
): Promise<ImportNxTestingResult> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const runner = options.runner ?? runProcess;
  const source = await readNxSource(
    workspaceRoot,
    options.expectedGitSha,
    runner,
  );
  const graph = await readGraphOrReport(workspaceRoot, source, runner);
  const workspace = await readWorkspaceProjects(workspaceRoot, source, runner);
  const fallbackDependencies = await resolveFallbackOrReport({
    workspaceRoot,
    source,
    workspace,
    graph,
  });
  const conversion = await convertProjects(
    workspaceRoot,
    workspace.parsedProjects,
  );
  const manifest = buildManifest(workspace, conversion, fallbackDependencies);
  const manifestContents = stableJson(manifest);
  const report = buildReport({
    source,
    workspace,
    graph,
    conversion,
    manifestChecksum: sha256(manifestContents),
  });
  return writeImportOutputs(workspaceRoot, manifest, manifestContents, report);
}

// --- Phases --------------------------------------------------------------

/** Pins the source tree, then reads everything that is not a project. */
async function readNxSource(
  workspaceRoot: string,
  expectedGitSha: string,
  runner: NxCommandRunner,
): Promise<NxSource> {
  const gitSnapshot = await requireCleanCommittedWorkspace(
    workspaceRoot,
    expectedGitSha,
    runner,
  );
  const nxExecutable = await resolveLocalNxCli(workspaceRoot);
  const versions = await readVersions(workspaceRoot, nxExecutable, runner);
  const rootInputs = await digestInputs(workspaceRoot);
  const nxConfig = await readOptionalJson(path.join(workspaceRoot, "nx.json"));
  const plugins = readNxPlugins(nxConfig);
  const projects = await readProjects(workspaceRoot, nxExecutable, runner);
  return {
    gitSnapshot,
    nxExecutable,
    versions,
    rootInputs,
    plugins,
    projects,
  };
}

/** Reads the project graph, or leaves a report saying why it could not. */
async function readGraphOrReport(
  workspaceRoot: string,
  source: NxSource,
  runner: NxCommandRunner,
): Promise<JsonValue> {
  try {
    return await readProjectGraph(workspaceRoot, source.nxExecutable, runner);
  } catch (error: unknown) {
    const message = failureMessage(error, "Unknown graph collection failure.");
    await writeUnsupportedGraphReport({
      workspaceRoot,
      source,
      inputs: source.rootInputs,
      message,
    });
    throw new Error(message, { cause: error });
  }
}

/** Reads every project, and digests the files each one is derived from. */
async function readWorkspaceProjects(
  workspaceRoot: string,
  source: NxSource,
  runner: NxCommandRunner,
): Promise<NxWorkspaceProjects> {
  const snapshots = await Promise.all(
    source.projects.map(async (project) => ({
      name: project,
      value: await readNxProjectConfiguration(
        workspaceRoot,
        source.nxExecutable,
        runner,
        project,
      ),
    })),
  );
  const parsed = snapshots.map((snapshot) =>
    parseProject(snapshot.value, snapshot.name),
  );
  const inputs = await digestProjectInputs(
    workspaceRoot,
    source.rootInputs,
    parsed.map((project) => project.root),
  );
  return {
    snapshots,
    parsedProjects: [...parsed].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    inputs,
  };
}

/** Reads the fallback edges, or leaves a report naming the shape it saw. */
async function resolveFallbackOrReport(input: {
  readonly workspaceRoot: string;
  readonly source: NxSource;
  readonly workspace: NxWorkspaceProjects;
  readonly graph: JsonValue;
}): Promise<ReadonlyMap<string, readonly string[]>> {
  try {
    return parseNxGraphFallbackDependencies(
      input.graph,
      input.workspace.parsedProjects,
    );
  } catch (error: unknown) {
    const message = failureMessage(error, "Unknown Nx graph shape failure.");
    await writeUnsupportedGraphReport({
      workspaceRoot: input.workspaceRoot,
      source: input.source,
      inputs: input.workspace.inputs,
      graph: input.graph,
      resolvedProjects: input.workspace.snapshots,
      message,
    });
    throw new Error(message, { cause: error });
  }
}

/** Converts every target of every project, keeping the audit for each one. */
async function convertProjects(
  workspaceRoot: string,
  projects: readonly NxProject[],
): Promise<ProjectConversion> {
  const conversions: TargetConversion[] = [];
  const executors = new Set<string>();
  let targetCount = 0;
  for (const project of projects) {
    const sourceLocation = relativeLocation(workspaceRoot, project.root);
    for (const target of project.targets) {
      targetCount += 1;
      if (target.executor) executors.add(target.executor);
      conversions.push(
        await convertTarget({ workspaceRoot, project, target, sourceLocation }),
      );
    }
  }
  return {
    tasks: conversions.flatMap((one) => (one.task ? [one.task] : [])),
    audits: conversions.map((one) => one.audit),
    droppedFields: conversions.flatMap((one) => one.droppedFields),
    failures: conversions.flatMap((one) => (one.failure ? [one.failure] : [])),
    executors: [...executors].sort(),
    targetCount,
  };
}

// --- The two outputs -----------------------------------------------------

/** The manifest: projects and tasks, each sorted by its Dads identifier. */
function buildManifest(
  workspace: NxWorkspaceProjects,
  conversion: ProjectConversion,
  fallbackDependencies: ReadonlyMap<string, readonly string[]>,
): DadsTestingManifest {
  return {
    schemaVersion: 1,
    workspace: {
      root: ".",
      fullFallback: {
        taskIds: conversion.tasks.map((task) => task.id).sort(),
      },
    },
    projects: workspace.parsedProjects
      .map((project) => ({
        id: project.id,
        root: project.root,
        fallbackDependencies: fallbackDependencies.get(project.name) ?? [],
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    tasks: [...conversion.tasks].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
}

/** The report: what was read, what it became, and everything left behind. */
function buildReport(input: {
  readonly source: NxSource;
  readonly workspace: NxWorkspaceProjects;
  readonly graph: JsonValue;
  readonly conversion: ProjectConversion;
  readonly manifestChecksum: string | null;
}): NxImportReport {
  const { source, workspace, conversion } = input;
  return {
    schemaVersion: 1,
    importer: {
      name: "@dads-framework/testing-import-nx",
      manifestChecksum: input.manifestChecksum,
    },
    source: {
      workspaceRoot: ".",
      expectedGitSha: source.gitSnapshot.expected,
      resolvedGitSha: source.gitSnapshot.resolved,
      versions: source.versions,
      inputs: workspace.inputs,
      locations: workspace.inputs.map((entry) => entry.path),
    },
    nx: {
      projects: source.projects,
      resolvedProjects: resolvedConfigurations(workspace.snapshots),
      projectGraph: input.graph,
      executors: conversion.executors,
      plugins: source.plugins,
    },
    summary: {
      projects: source.projects.length,
      targets: conversion.targetCount,
      converted: conversion.tasks.length,
      excluded: conversion.audits.length - conversion.tasks.length,
    },
    tasks: [...conversion.audits].sort(byAuditIdentity),
    droppedFields: [...conversion.droppedFields].sort(byDroppedFieldIdentity),
    failures: [...conversion.failures].sort((left, right) =>
      left.subject.localeCompare(right.subject),
    ),
  };
}

/** Each project's configuration exactly as Nx gave it, sorted by name. */
function resolvedConfigurations(
  snapshots: readonly NxProjectSnapshot[],
): readonly { readonly name: string; readonly configuration: JsonValue }[] {
  return snapshots
    .map((snapshot) => ({
      name: snapshot.name,
      configuration: snapshot.value,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Writes both outputs, or — when nothing converted — only the report. A strict
 * v1 manifest needs at least one task, so an empty import is a failure that
 * still leaves the evidence of why behind.
 */
async function writeImportOutputs(
  workspaceRoot: string,
  manifest: DadsTestingManifest,
  manifestContents: string,
  report: NxImportReport,
): Promise<ImportNxTestingResult> {
  const manifestPath = path.join(workspaceRoot, outputManifestName);
  const reportPath = path.join(workspaceRoot, outputReportName);
  if (manifest.tasks.length === 0) {
    const contents = stableJson(noStandaloneReport(report));
    await writeOutputsAtomically([{ path: reportPath, contents }]);
    throw new Error(
      "No standalone Nx tasks were convertible; see dads.testing.import-report.json.",
    );
  }
  await writeOutputsAtomically([
    { path: manifestPath, contents: manifestContents },
    { path: reportPath, contents: stableJson(report) },
  ]);
  return { manifest, report, manifestPath, reportPath };
}

/** The report as it reads when no manifest was written beside it. */
function noStandaloneReport(report: NxImportReport): NxImportReport {
  return {
    ...report,
    importer: { ...report.importer, manifestChecksum: null },
    failures: [
      ...report.failures,
      {
        stage: "conversion",
        subject: "manifest",
        message:
          "No standalone tasks were convertible; no dads.testing.json was written because strict v1 manifests require at least one task.",
      },
    ],
  };
}

/** Nothing converted, because nothing was ever read. */
const nothingConverted: ProjectConversion = {
  tasks: [],
  audits: [],
  droppedFields: [],
  failures: [],
  executors: [],
  targetCount: 0,
};

/**
 * The report an import leaves behind when Nx answered in a shape this
 * importer does not understand: the same report as a successful import, made
 * of everything that had been read, carrying the one failure that stopped it.
 */
async function writeUnsupportedGraphReport(input: {
  readonly workspaceRoot: string;
  readonly source: NxSource;
  readonly inputs: readonly DigestedInput[];
  readonly graph?: JsonValue;
  readonly resolvedProjects?: readonly NxProjectSnapshot[];
  readonly message: string;
}): Promise<void> {
  const report = buildReport({
    source: input.source,
    workspace: {
      snapshots: input.resolvedProjects ?? [],
      parsedProjects: [],
      inputs: input.inputs,
    },
    graph: input.graph ?? null,
    conversion: nothingConverted,
    manifestChecksum: null,
  });
  await writeOutputsAtomically([
    {
      path: path.join(input.workspaceRoot, outputReportName),
      contents: stableJson({
        ...report,
        failures: [
          {
            stage: "graph",
            subject: "nx graph --file",
            message: input.message,
          },
        ],
      }),
    },
  ]);
}

// --- Ordering ------------------------------------------------------------

/** `error`'s message, or `fallback` when it was not an `Error` at all. */
function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function byAuditIdentity(
  left: ImportedTaskAudit,
  right: ImportedTaskAudit,
): number {
  return `${left.project}:${left.target}`.localeCompare(
    `${right.project}:${right.target}`,
  );
}

function byDroppedFieldIdentity(
  left: DroppedField,
  right: DroppedField,
): number {
  return `${left.project}:${left.target}:${left.field}`.localeCompare(
    `${right.project}:${right.target}:${right.field}`,
  );
}
