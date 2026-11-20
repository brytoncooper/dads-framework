import { promises as fs } from "node:fs";
import path from "node:path";
import {
  planTesting,
  runTesting,
  type TestingOperationRequest,
  type TestingPlanResult,
  type TestingRunResult,
} from "@dads-framework/testing";
import { parseNxConfiguration, resolveLocalNxCli } from "./nx-installation.js";
import {
  buildNativeNxManifest,
  type NativeNxCoverage,
} from "./nx-native-model.js";
import { nativeNxProcess } from "./nx-native-process.js";
import { requireNativeNxScope } from "./nx-native-scope.js";
import {
  createNativeNxScratch,
  nativeNxSourceIdentity,
} from "./nx-native-scratch.js";

export type NativeNxTestingOptions = Omit<
  TestingOperationRequest,
  "manifestPath" | "taskIds"
> & {
  /** Exact Nx target names; omitted selects verification target families. */
  readonly targetNames?: readonly string[];
};

export type NativeNxTestingResult = {
  readonly coverage: NativeNxCoverage;
  readonly plan: TestingPlanResult;
  readonly run?: TestingRunResult;
};

/** Discovers current targets on every call; does not execute any Nx target. */
export async function planNativeNxTesting(
  options: NativeNxTestingOptions,
): Promise<NativeNxTestingResult> {
  return withNativeNxManifest(options, false);
}

/** Lets Nx execute the targets selected by Dads, preserving native prerequisites. */
export async function runNativeNxTesting(
  options: NativeNxTestingOptions,
): Promise<NativeNxTestingResult> {
  return withNativeNxManifest(options, true);
}

async function withNativeNxManifest(
  options: NativeNxTestingOptions,
  run: boolean,
): Promise<NativeNxTestingResult> {
  const workspaceRoot = await fs.realpath(path.resolve(options.workspaceRoot));
  await requireNativeNxScope({ ...options, workspaceRoot });
  const nxCli = await resolveLocalNxCli(workspaceRoot);
  const scratch = await createNativeNxScratch(workspaceRoot);
  try {
    const before = await nativeNxSourceIdentity(workspaceRoot);
    const { manifest, coverage } = await discoverManifest(
      workspaceRoot,
      nxCli,
      scratch,
      options.targetNames,
    );
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
    manifestPath: path
      .relative(workspaceRoot, manifestFile)
      .split(path.sep)
      .join("/"),
  };
}

async function discoverManifest(
  workspaceRoot: string,
  nxCli: string,
  scratch: string,
  targetNames: readonly string[] | undefined,
) {
  const graphPath = path.join(scratch, "project-graph.json");
  await nativeNxProcess(
    process.execPath,
    [nxCli, "graph", `--file=${graphPath}`, "--open=false"],
    workspaceRoot,
    {
      NX_WORKSPACE_DATA_DIRECTORY: path.join(scratch, "workspace-data"),
      NX_CACHE_DIRECTORY: path.join(scratch, "cache"),
    },
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

async function requireUnchangedSource(
  workspaceRoot: string,
  before: string,
): Promise<void> {
  if (before !== (await nativeNxSourceIdentity(workspaceRoot))) {
    throw new Error(
      "The workspace changed during Nx discovery, planning, or execution. Retry against a stable working tree; these results are not valid.",
    );
  }
}
