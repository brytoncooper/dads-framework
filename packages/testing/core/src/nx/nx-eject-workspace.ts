/**
 * One-command Nx eject: turns a live Nx project graph (including plugin-inferred
 * Vitest, ESLint, TypeScript, and `nx:run-commands` targets) into a standalone,
 * zero-Nx `dads.testing.json` with symbol-level reachability, Vitest file
 * narrowing, pure-check `dependsOn` wiring, and optional `nxViteTsPaths()` ->
 * `dadsTsconfigPaths()` codemodding.
 */
import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { checkTestingManifest } from "../init/check-testing-manifest.js";
import { isRecord } from "../parse-guards.js";
import { planTesting } from "../testing-api.js";
import {
  defaultTestingManifestFileName,
  serializeTestingManifest,
  type TestingManifest,
  type TestingManifestTask,
} from "../testing-manifest.js";
import { writeFilesAtomically } from "../write-files-atomically.js";
import { dadsIdentifier } from "./dads-identifier.js";
import { ejectTarget, type EjectedTargetAudit, type EjectedTargetResult } from "./nx-eject-targets.js";
import { detectWorkspaceTsconfig, rewriteNxViteTsPaths, type RewriteNxViteResult } from "./nx-eject-vitest.js";
import { parseNxConfiguration, resolveLocalNxCli } from "./nx-installation.js";
import { readNativeProjects, type NativeProject } from "./nx-native-graph.js";
import type { PrerequisiteTarget } from "./nx-native-inputs.js";
import { reachesTask } from "./nx-native-model.js";
import { nativeNxProcess } from "./nx-native-process.js";
import { createNativeNxScratch } from "./nx-native-scratch.js";

export const ejectReportFileName = "dads.testing.eject-report.json";

export type NativeNxEjectOptions = {
  readonly workspaceRoot: string;
  /** Exact Nx target names; omitted selects verification target families. */
  readonly targetNames?: readonly string[];
  /** Write `dads.testing.json` and `dads.testing.eject-report.json` (default: false = dry-run preview). */
  readonly write?: boolean;
  /** Allow overwriting an existing `dads.testing.json` when `write` is true. */
  readonly force?: boolean;
  /** Rewrite clean `nxViteTsPaths()` usages to `dadsTsconfigPaths()` when `write` is true. */
  readonly replaceNxViteTsPaths?: boolean;
  /** Explicit native binary path used to validate the generated manifest. */
  readonly nativeBinary?: string;
};

export type NativeNxEjectReport = {
  readonly schemaVersion: 1;
  readonly dryRun: boolean;
  readonly summary: {
    readonly projects: number;
    readonly targets: number;
    readonly converted: number;
    readonly opaque: number;
    readonly excluded: number;
    readonly vitestNarrowed: number;
    readonly nxViteConfigsFound: number;
    readonly nxViteConfigsRewritten: number;
  };
  readonly tasks: readonly EjectedTargetAudit[];
  readonly nxViteConfigs: readonly RewriteNxViteResult[];
  readonly nxPackagesDetected: readonly string[];
  readonly uninstallCommands: readonly string[];
};

export type NativeNxEjectResult = {
  readonly manifest: TestingManifest;
  readonly report: NativeNxEjectReport;
  readonly written: boolean;
  readonly manifestPath: string;
  readonly reportPath: string;
};

type EjectedEntry = {
  readonly task: TestingManifestTask;
  readonly checkPrerequisites: readonly PrerequisiteTarget[];
};

/** Discovers the live Nx graph and builds (or writes) a standalone zero-Nx `dads.testing.json`. */
export async function ejectNativeNxTesting(options: NativeNxEjectOptions): Promise<NativeNxEjectResult> {
  const workspaceRoot = await fs.realpath(path.resolve(options.workspaceRoot));
  const manifestPath = path.join(workspaceRoot, defaultTestingManifestFileName);
  const reportPath = path.join(workspaceRoot, ejectReportFileName);
  const write = options.write === true;
  if (write && existsSync(manifestPath) && options.force !== true) {
    throw new Error(`Refusing to overwrite existing ${defaultTestingManifestFileName}; pass --force to replace it.`);
  }
  const { graph, nxConfiguration } = await readLiveNxGraph(workspaceRoot);
  const projects = readNativeProjects(graph);
  const built = convertWorkspaceTargets(workspaceRoot, projects, nxConfiguration, options.targetNames);
  const manifest = assembleManifest(projects, built.tasks);
  assertStructurallyValid(manifest);
  const nxViteConfigs = handleNxViteConfigs(
    workspaceRoot,
    built.nxViteConfigPaths,
    write && options.replaceNxViteTsPaths === true,
  );
  const nxPackagesDetected = detectNxPackages(workspaceRoot);
  const report = buildEjectReport(projects.size, built, nxViteConfigs, nxPackagesDetected, !write);
  if (write) {
    await writeValidatedOutputs(workspaceRoot, manifestPath, reportPath, manifest, report, options.nativeBinary);
  }
  return { manifest, report, written: write, manifestPath, reportPath };
}

async function readLiveNxGraph(workspaceRoot: string): Promise<{
  readonly graph: unknown;
  readonly nxConfiguration: unknown;
}> {
  const nxCli = await resolveLocalNxCli(workspaceRoot);
  const scratch = await createNativeNxScratch(workspaceRoot);
  try {
    const graphPath = path.join(scratch, "project-graph.json");
    const env = (await isNxDirIgnored(workspaceRoot))
      ? {}
      : {
          NX_WORKSPACE_DATA_DIRECTORY: path.join(scratch, "workspace-data"),
          NX_CACHE_DIRECTORY: path.join(scratch, "cache"),
        };
    await nativeNxProcess(
      process.execPath,
      [nxCli, "graph", `--file=${graphPath}`, "--open=false"],
      workspaceRoot,
      env,
    );
    const graph: unknown = JSON.parse(await fs.readFile(graphPath, "utf8"));
    const nxConfiguration = parseNxConfiguration(
      await fs.readFile(path.join(workspaceRoot, "nx.json"), "utf8"),
      "nx.json",
    );
    return { graph, nxConfiguration };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function isNxDirIgnored(workspaceRoot: string): Promise<boolean> {
  try {
    await nativeNxProcess("git", ["check-ignore", "--quiet", "--", ".nx/"], workspaceRoot);
    return true;
  } catch {
    return false;
  }
}

function convertWorkspaceTargets(
  workspaceRoot: string,
  projects: ReadonlyMap<string, NativeProject>,
  nxConfiguration: unknown,
  targetNames: readonly string[] | undefined,
): {
  readonly tasks: readonly TestingManifestTask[];
  readonly audits: readonly EjectedTargetAudit[];
  readonly nxViteConfigPaths: readonly string[];
} {
  const entries = new Map<string, EjectedEntry>();
  const auditsByKey = new Map<string, EjectedTargetAudit>();
  const nxViteConfigPaths = new Set<string>();
  const pendingPrereqs: PrerequisiteTarget[] = [];

  for (const project of projects.values()) {
    for (const [name, value] of Object.entries(project.targets).sort(([l], [r]) => l.localeCompare(r))) {
      const key = `${project.name}:${name}`;
      if (!isRecord(value)) continue;
      const chosen = targetNames === undefined ? isVerificationTarget(name) : targetNames.includes(name);
      if (value["continuous"] === true || !chosen) {
        auditsByKey.set(key, {
          project: project.name,
          target: name,
          classification: "excluded",
          reason:
            value["continuous"] === true ? "Continuous targets are excluded." : "Outside requested verification scope.",
        });
        continue;
      }
      const result = ejectTarget({ workspaceRoot, project, name, target: value, projects, nxConfiguration });
      recordEjected(key, result, entries, auditsByKey, nxViteConfigPaths, pendingPrereqs);
    }
  }
  ejectCheckPrerequisites(
    workspaceRoot,
    projects,
    nxConfiguration,
    entries,
    auditsByKey,
    nxViteConfigPaths,
    pendingPrereqs,
  );
  return {
    tasks: wireDependencies(entries),
    audits: [...auditsByKey.values()],
    nxViteConfigPaths: [...nxViteConfigPaths].sort(),
  };
}

function ejectCheckPrerequisites(
  workspaceRoot: string,
  projects: ReadonlyMap<string, NativeProject>,
  nxConfiguration: unknown,
  entries: Map<string, EjectedEntry>,
  auditsByKey: Map<string, EjectedTargetAudit>,
  nxViteConfigPaths: Set<string>,
  pendingPrereqs: PrerequisiteTarget[],
): void {
  for (let index = 0; index < pendingPrereqs.length; index += 1) {
    const prereq = pendingPrereqs[index];
    if (prereq === undefined) continue;
    const id = `${dadsIdentifier(prereq.project.name)}:${dadsIdentifier(prereq.name)}`;
    if (entries.has(id)) continue;
    const raw = prereq.project.targets[prereq.name];
    if (!isRecord(raw) || raw["continuous"] === true) continue;
    const result = ejectTarget({
      workspaceRoot,
      project: prereq.project,
      name: prereq.name,
      target: raw,
      projects,
      nxConfiguration,
    });
    recordEjected(
      `${prereq.project.name}:${prereq.name}`,
      result,
      entries,
      auditsByKey,
      nxViteConfigPaths,
      pendingPrereqs,
    );
  }
}

function recordEjected(
  key: string,
  result: EjectedTargetResult,
  entries: Map<string, EjectedEntry>,
  auditsByKey: Map<string, EjectedTargetAudit>,
  nxViteConfigPaths: Set<string>,
  pendingPrereqs: PrerequisiteTarget[],
): void {
  auditsByKey.set(key, result.audit);
  if (result.nxViteConfigPath !== undefined) nxViteConfigPaths.add(result.nxViteConfigPath);
  if (result.task !== undefined) {
    entries.set(result.task.id, { task: result.task, checkPrerequisites: result.checkPrerequisites });
    pendingPrereqs.push(...result.checkPrerequisites);
  }
}

function wireDependencies(entries: ReadonlyMap<string, EjectedEntry>): readonly TestingManifestTask[] {
  const edges = new Map<string, string[]>();
  const tasks: TestingManifestTask[] = [];
  for (const entry of entries.values()) {
    const dependsOn: string[] = [];
    for (const prereq of entry.checkPrerequisites) {
      const targetId = `${dadsIdentifier(prereq.project.name)}:${dadsIdentifier(prereq.name)}`;
      if (targetId === entry.task.id || !entries.has(targetId) || reachesTask(targetId, entry.task.id, edges)) continue;
      if (!dependsOn.includes(targetId)) dependsOn.push(targetId);
    }
    dependsOn.sort();
    edges.set(entry.task.id, dependsOn);
    tasks.push({ ...entry.task, dependsOn });
  }
  return tasks.sort((left, right) => left.id.localeCompare(right.id));
}

function assembleManifest(
  projects: ReadonlyMap<string, NativeProject>,
  tasks: readonly TestingManifestTask[],
): TestingManifest {
  if (tasks.length === 0) {
    throw new Error("No Nx targets could be ejected to standalone Dads tasks.");
  }
  return {
    schemaVersion: 1,
    workspace: {
      root: ".",
      fullFallback: { taskIds: tasks.map((task) => task.id).sort() },
    },
    projects: [...projects.values()]
      .map((project) => ({
        id: dadsIdentifier(project.name),
        root: project.root,
        fallbackDependencies: project.dependencies.map(dadsIdentifier).sort(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    tasks,
  };
}

function assertStructurallyValid(manifest: TestingManifest): void {
  const issues = checkTestingManifest(manifest);
  if (issues.length > 0) {
    throw new Error(`Ejected manifest failed structural validation: ${issues.join(" ")}`);
  }
}

function handleNxViteConfigs(
  workspaceRoot: string,
  configPaths: readonly string[],
  applyRewrite: boolean,
): readonly RewriteNxViteResult[] {
  const workspaceTsconfig = detectWorkspaceTsconfig(workspaceRoot);
  return configPaths.map((configPath) =>
    applyRewrite
      ? rewriteNxViteTsPaths(workspaceRoot, configPath, workspaceTsconfig)
      : {
          configPath,
          status: "manual-review-needed",
          detail: "Uses nxViteTsPaths(); re-run with --write --replace-nx-vite-paths to swap to dadsTsconfigPaths().",
        },
  );
}

function detectNxPackages(workspaceRoot: string): readonly string[] {
  const parsed = readWorkspaceManifestJson(workspaceRoot);
  if (parsed === undefined) return [];
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    collectNxNames(parsed[field], names);
  }
  return [...names].sort();
}

function readWorkspaceManifestJson(workspaceRoot: string): Readonly<Record<string, unknown>> | undefined {
  const packageJsonPath = path.join(workspaceRoot, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function collectNxNames(section: unknown, names: Set<string>): void {
  if (!isRecord(section)) return;
  for (const name of Object.keys(section)) {
    if (name === "nx" || name.startsWith("@nx/")) names.add(name);
  }
}

function buildEjectReport(
  projectCount: number,
  built: { readonly tasks: readonly TestingManifestTask[]; readonly audits: readonly EjectedTargetAudit[] },
  nxViteConfigs: readonly RewriteNxViteResult[],
  nxPackagesDetected: readonly string[],
  dryRun: boolean,
): NativeNxEjectReport {
  const uninstallCommands = [
    "npx dad-test plan --base origin/main",
    "npx dad-test run --base origin/main --cache",
    "rm -rf nx.json .nx",
    ...(nxPackagesDetected.length > 0 ? [`npm uninstall ${nxPackagesDetected.join(" ")}`] : []),
  ];
  return {
    schemaVersion: 1,
    dryRun,
    summary: {
      projects: projectCount,
      targets: built.audits.length,
      converted: built.tasks.length,
      opaque: built.audits.filter((a) => a.classification === "opaque").length,
      excluded: built.audits.filter((a) => a.classification === "excluded").length,
      vitestNarrowed: built.tasks.filter((t) => t.execution.fileNarrowing !== undefined).length,
      nxViteConfigsFound: nxViteConfigs.length,
      nxViteConfigsRewritten: nxViteConfigs.filter((c) => c.status === "rewritten").length,
    },
    tasks: built.audits,
    nxViteConfigs,
    nxPackagesDetected,
    uninstallCommands,
  };
}

async function writeValidatedOutputs(
  workspaceRoot: string,
  manifestPath: string,
  reportPath: string,
  manifest: TestingManifest,
  report: NativeNxEjectReport,
  nativeBinary: string | undefined,
): Promise<void> {
  const manifestText = serializeTestingManifest(manifest);
  writeFilesAtomically([
    { path: manifestPath, contents: manifestText },
    { path: reportPath, contents: `${JSON.stringify(report, null, 2)}\n` },
  ]);
  if (nativeBinary !== undefined) {
    await planTesting({
      workspaceRoot,
      manifestPath: defaultTestingManifestFileName,
      all: true,
      taskIds: [],
      nativeBinary,
    });
  }
}

function isVerificationTarget(name: string): boolean {
  return /^(test|typecheck|lint|build)$/.test(name) || /^(test:|typecheck[:-]|lint[:-])/.test(name);
}
