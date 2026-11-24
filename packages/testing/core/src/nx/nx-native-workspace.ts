import { promises as fs } from "node:fs";
import path from "node:path";
import {
  diagnoseTesting,
  planTesting,
  runTesting,
  type TestingDiagnoseResult,
  type TestingOperationRequest,
  type TestingPlanResult,
  type TestingRunResult,
} from "../testing-api.js";
import { parseNxConfiguration, resolveLocalNxCli } from "./nx-installation.js";
import { buildNativeNxManifest, type NativeNxCoverage } from "./nx-native-model.js";
import { nativeNxProcess } from "./nx-native-process.js";
import { requireNativeNxScope } from "./nx-native-scope.js";
import { createNativeNxScratch, nativeNxSourceIdentity } from "./nx-native-scratch.js";
import { hasSnapshotRevision, isCleanWorkingTree, withEphemeralNxSnapshot } from "./nx-native-snapshot.js";

export type NativeNxTestingOptions = Omit<TestingOperationRequest, "manifestPath" | "taskIds"> & {
  /** Exact Nx target names; omitted selects verification target families. */
  readonly targetNames?: readonly string[];
  /** Plan inside an ephemeral detached Git worktree snapshot so live edits cannot interrupt discovery. */
  readonly snapshot?: boolean;
};

export type NativeNxTestingResult = {
  readonly coverage: NativeNxCoverage;
  readonly plan: TestingPlanResult;
  readonly run?: TestingRunResult;
};

export type NativeNxDiagnoseOptions = {
  readonly workspaceRoot: string;
  /** Exact Nx target names; omitted selects verification target families. */
  readonly targetNames?: readonly string[];
  /** Git revision to diagnose inside an isolated temporary worktree (defaults to HEAD when available). */
  readonly head?: string;
  /** Explicit native binary path for local development and tests. */
  readonly nativeBinary?: string;
};

export type NativeNxDiagnoseResult = {
  readonly coverage: NativeNxCoverage;
  readonly diagnose: TestingDiagnoseResult;
};

/** Discovers current targets on every call; does not execute any Nx target. */
export async function planNativeNxTesting(options: NativeNxTestingOptions): Promise<NativeNxTestingResult> {
  if (options.head !== undefined || options.snapshot === true) {
    return planInEphemeralSnapshot(options);
  }
  return withNativeNxManifest(options, false);
}

/** Lets Nx execute the targets selected by Dads, preserving native prerequisites. */
export async function runNativeNxTesting(options: NativeNxTestingOptions): Promise<NativeNxTestingResult> {
  if (options.snapshot === true) {
    throw new Error("--snapshot is only supported for plan; omit --snapshot to execute targets in the working tree.");
  }
  return withNativeNxManifest(options, true);
}

/** Runs `dad-test diagnose` against an isolated Git snapshot when dirty or pinned to `--head`. */
export async function diagnoseNativeNxTesting(options: NativeNxDiagnoseOptions): Promise<NativeNxDiagnoseResult> {
  const workspaceRoot = await fs.realpath(path.resolve(options.workspaceRoot));
  const revision = options.head ?? "HEAD";
  const needsSnapshot =
    options.head !== undefined ||
    ((await hasSnapshotRevision(workspaceRoot, revision)) && !(await isCleanWorkingTree(workspaceRoot)));
  if (needsSnapshot) {
    return withEphemeralNxSnapshot(workspaceRoot, revision, ({ snapshotRoot }) =>
      runDiagnoseInWorkspace(snapshotRoot, options, true),
    );
  }
  return runDiagnoseInWorkspace(workspaceRoot, options, false);
}

async function runDiagnoseInWorkspace(
  workspaceRoot: string,
  options: NativeNxDiagnoseOptions,
  isolatedSnapshot: boolean,
): Promise<NativeNxDiagnoseResult> {
  const nxCli = await resolveLocalNxCli(workspaceRoot);
  const scratch = await createNativeNxScratch(workspaceRoot);
  try {
    const before = isolatedSnapshot ? undefined : await nativeNxSourceIdentity(workspaceRoot);
    const { manifest, coverage } = await discoverManifest(
      workspaceRoot,
      nxCli,
      scratch,
      options.targetNames,
      isolatedSnapshot,
    );
    const manifestFile = path.join(scratch, "manifest.json");
    await fs.writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
    if (before !== undefined) await requireUnchangedSource(workspaceRoot, before);
    const diagnose = await diagnoseTesting({
      workspaceRoot,
      manifestPath: path.relative(workspaceRoot, manifestFile).split(path.sep).join("/"),
      ...(options.nativeBinary === undefined ? {} : { nativeBinary: options.nativeBinary }),
    });
    if (before !== undefined) await requireUnchangedSource(workspaceRoot, before);
    return { coverage, diagnose };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
    await fs.rmdir(path.dirname(scratch)).catch(() => undefined);
  }
}

async function planInEphemeralSnapshot(options: NativeNxTestingOptions): Promise<NativeNxTestingResult> {
  validateSnapshotPlanScope(options);
  const workspaceRoot = await fs.realpath(path.resolve(options.workspaceRoot));
  const targetRevision = options.head ?? "HEAD";
  return withEphemeralNxSnapshot(workspaceRoot, targetRevision, async ({ snapshotRoot, revision }) => {
    const nxCli = await resolveLocalNxCli(snapshotRoot);
    const scratch = await createNativeNxScratch(snapshotRoot);
    try {
      const { manifest, coverage } = await discoverManifest(snapshotRoot, nxCli, scratch, options.targetNames, true);
      const manifestFile = path.join(scratch, "manifest.json");
      await fs.writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
      const plan = await planTesting(snapshotPlanRequest(options, snapshotRoot, revision, manifestFile));
      return { coverage, plan };
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });
}

function validateSnapshotPlanScope(options: NativeNxTestingOptions): void {
  if (options.all && (options.base !== undefined || options.head !== undefined)) {
    throw new Error("--all cannot be combined with --base or --head.");
  }
  if (options.head !== undefined && options.base === undefined) {
    throw new Error("--head requires --base.");
  }
}

function snapshotPlanRequest(
  options: NativeNxTestingOptions,
  snapshotRoot: string,
  revision: string,
  manifestFile: string,
): TestingOperationRequest {
  return {
    workspaceRoot: snapshotRoot,
    manifestPath: path.relative(snapshotRoot, manifestFile).split(path.sep).join("/"),
    ...(options.base === undefined ? {} : { base: options.base, head: revision }),
    ...(options.all === undefined ? {} : { all: options.all }),
    ...(options.jobs === undefined ? {} : { jobs: options.jobs }),
    ...(options.nativeBinary === undefined ? {} : { nativeBinary: options.nativeBinary }),
  };
}

async function withNativeNxManifest(options: NativeNxTestingOptions, run: boolean): Promise<NativeNxTestingResult> {
  const workspaceRoot = await fs.realpath(path.resolve(options.workspaceRoot));
  await requireNativeNxScope({ ...options, workspaceRoot });
  const nxCli = await resolveLocalNxCli(workspaceRoot);
  const scratch = await createNativeNxScratch(workspaceRoot);
  try {
    const before = await nativeNxSourceIdentity(workspaceRoot);
    const { manifest, coverage } = await discoverManifest(workspaceRoot, nxCli, scratch, options.targetNames);
    const manifestFile = path.join(scratch, "manifest.json");
    await fs.writeFile(manifestFile, `${JSON.stringify(manifest)}\n`);
    await requireUnchangedSource(workspaceRoot, before);
    const request = nativeRequest(options, workspaceRoot, manifestFile);
    if (run) {
      const result = await runTesting(request);
      await requireUnchangedSource(workspaceRoot, before);
      return { coverage, ...result };
    }
    const plan = await planTesting(request);
    await requireUnchangedSource(workspaceRoot, before);
    return { coverage, plan };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

function nativeRequest(
  options: NativeNxTestingOptions,
  workspaceRoot: string,
  manifestFile: string,
): TestingOperationRequest {
  return {
    ...options,
    workspaceRoot,
    manifestPath: path.relative(workspaceRoot, manifestFile).split(path.sep).join("/"),
  };
}

async function discoverManifest(
  workspaceRoot: string,
  nxCli: string,
  scratch: string,
  targetNames: readonly string[] | undefined,
  forceIsolatedCache = false,
) {
  const graphPath = path.join(scratch, "project-graph.json");
  const nxCacheEnv =
    !forceIsolatedCache && (await isNxDirectoryIgnored(workspaceRoot))
      ? {}
      : {
          NX_WORKSPACE_DATA_DIRECTORY: path.join(scratch, "workspace-data"),
          NX_CACHE_DIRECTORY: path.join(scratch, "cache"),
        };
  await nativeNxProcess(
    process.execPath,
    [nxCli, "graph", `--file=${graphPath}`, "--open=false"],
    workspaceRoot,
    nxCacheEnv,
  );
  const graph: unknown = JSON.parse(await fs.readFile(graphPath, "utf8"));
  const nxConfiguration = parseNxConfiguration(
    await fs.readFile(path.join(workspaceRoot, "nx.json"), "utf8"),
    "nx.json",
  );
  return buildNativeNxManifest({
    graph,
    nxConfiguration,
    nxCli,
    ...(targetNames === undefined ? {} : { targetNames }),
  });
}

async function isNxDirectoryIgnored(workspaceRoot: string): Promise<boolean> {
  try {
    await nativeNxProcess("git", ["check-ignore", "--quiet", "--", ".nx/"], workspaceRoot);
    return true;
  } catch {
    return false;
  }
}

async function requireUnchangedSource(workspaceRoot: string, before: string): Promise<void> {
  if (before !== (await nativeNxSourceIdentity(workspaceRoot))) {
    throw new Error(
      "The workspace changed during Nx discovery, planning, or execution. Retry against a stable working tree; these results are not valid.",
    );
  }
}
