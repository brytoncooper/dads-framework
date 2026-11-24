import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { resolveNativeTestingBinary } from "./native-platform.js";
import { parseTestingManifest, type TestingManifest } from "./testing-manifest.js";

const protocolSchemaVersion = 1;

export type TestingTaskShard = {
  readonly index: number;
  readonly total: number;
};

export type TestingOperationRequest = {
  readonly workspaceRoot: string;
  readonly manifestPath?: string;
  readonly base?: string;
  readonly head?: string;
  readonly all?: boolean;
  /** Run only explicitly named `--task` / `--project` / `--target` / `--kind` items without Git diff widening. */
  readonly only?: boolean;
  readonly taskIds?: readonly string[];
  readonly taskKinds?: readonly string[];
  readonly targets?: readonly string[];
  readonly projects?: readonly string[];
  readonly excludeProjects?: readonly string[];
  readonly shard?: TestingTaskShard;
  readonly shardWeights?: Readonly<Record<string, number>>;
  readonly jobs?: number;
  /** Opt-in content-hashed task receipt cache (`--cache` / `--no-cache`). Defaults to `false`. */
  readonly cache?: boolean;
  /** Optional L2 remote receipt store URL (`file://`, `http://`, `https://`, or `s3://`). */
  readonly remoteCacheUrl?: string;
  /** Stream live task progress to stderr during `run`. */
  readonly stream?: boolean;
  /** Optional sink receiving live progress chunks when `stream` is enabled. */
  readonly onStream?: (chunk: string) => void;
  /** An explicit native binary is intended for local development and test harnesses. */
  readonly nativeBinary?: string;
};

export type TestingTaskDecision = {
  readonly id: string;
  readonly decision: "run" | "skip-proven-unaffected";
  readonly reason: string;
  readonly confidence: string;
  readonly widened: boolean;
  /** The project owning the task, when the engine reports it. */
  readonly project?: string;
  /** Every reason this task was selected, when the engine reports them. */
  readonly causes?: readonly TestingTaskCause[];
  /** Workspace-relative paths reached inside this project when un-widened. */
  readonly reachedFiles?: readonly string[];
  /** Narrowed test files passed to the runner when `execution.fileNarrowing` applies. */
  readonly selectedFiles?: readonly string[];
};

/**
 * One reason a task was selected. `issue` refers to a position in the plan's
 * `issues` array as emitted, so a reader must keep that array in its original
 * order to resolve the reference.
 */
export type TestingTaskCause =
  | { readonly kind: "direct-task-input"; readonly taskId: string }
  | { readonly kind: "prerequisite-of"; readonly taskId: string }
  | { readonly kind: "changed-path"; readonly path: string }
  | {
      readonly kind: "changed-export";
      readonly path: string;
      readonly symbol: string;
    }
  | {
      readonly kind: "reached-import";
      readonly path: string;
      readonly line?: number;
      readonly column?: number;
      readonly importedFrom: string;
      readonly symbols: readonly string[];
    }
  | { readonly kind: "issue"; readonly index: number }
  | { readonly kind: "fallback-dependency"; readonly project: string }
  | { readonly kind: "sql-object"; readonly object: string };

/**
 * One planning issue. Every classifying field is optional: an engine older than
 * this facade reports only `code` and `message`, and `plan-issues.ts` derives
 * the rest from the code.
 */
export type TestingPlanIssue = {
  readonly code: string;
  readonly message: string;
  readonly severity?: "info" | "uncertainty" | "error";
  readonly scope?: "module" | "workspace";
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
  readonly project?: string;
};

export type TestingPlanResult = {
  readonly schemaVersion: 1;
  readonly scope: {
    readonly kind: string;
    readonly base?: string;
    readonly head?: string;
    readonly changedPaths: readonly string[];
    readonly fullFallback: boolean;
  };
  readonly tasks: readonly TestingTaskDecision[];
  readonly issues: readonly TestingPlanIssue[];
  readonly complete: boolean;
  readonly counts: {
    readonly run: number;
    readonly skipProvenUnaffected: number;
  };
};

export type TestingTaskRunResult = {
  readonly id: string;
  readonly status: "executed" | "failed" | "blocked" | "not-applicable";
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly stdout?: TestingTaskOutput;
  readonly stderr?: TestingTaskOutput;
  readonly error?: string;
  /** True when the passing outcome was replayed from a verified content-hashed receipt. */
  readonly cached?: boolean;
};

export type TestingTaskOutput = {
  readonly text: string;
  readonly truncated: boolean;
};

export type TestingRunResult = {
  readonly tasks: readonly TestingTaskRunResult[];
  readonly counts: {
    readonly executed: number;
    readonly failed: number;
    readonly blocked: number;
    readonly notApplicable: number;
    readonly cached?: number;
  };
  readonly exitCode: number;
};

export type TestingDiagnoseRequest = {
  readonly workspaceRoot: string;
  readonly manifestPath?: string;
  /** An explicit native binary is intended for local development and test harnesses. */
  readonly nativeBinary?: string;
};

export type TestingExpandManifestRequest = {
  readonly workspaceRoot: string;
  readonly manifestPath?: string;
  /** An explicit native binary is intended for local development and test harnesses. */
  readonly nativeBinary?: string;
};

export type TestingRemediationSafety = "safe" | "verify-before-changing" | "keep-widened-unless-verified";

export type TestingDiagnoseRemediation = {
  readonly safety: TestingRemediationSafety;
  readonly action: string;
  readonly caution: string;
  readonly verify: string;
};

export type TestingDiagnoseSummary = {
  readonly totalModules: number;
  readonly totalProjects: number;
  readonly totalTasks: number;
  readonly totalTestFiles: number;
  readonly totalUncertainties: number;
  readonly wholeWorkspaceUncertainties: number;
  readonly unownedTrackedFiles: number;
  readonly nonCodeUncoveredFiles: number;
  readonly estimatedLeafSkipPercent: number;
  readonly potentialLeafSkipPercent: number;
};

export type TestingWideningCulprit = {
  readonly code: string;
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly scope: "module" | "workspace";
  readonly project?: string;
  readonly message: string;
  readonly widenedProjects: number;
  readonly widenedTasks: number;
  readonly widenedTestFiles: number;
  readonly remediation: TestingDiagnoseRemediation;
};

export type TestingCouplingHotspot = {
  readonly path: string;
  readonly project?: string;
  readonly reachedModules: number;
  readonly reachedProjects: number;
  readonly reachedTestFiles: number;
  readonly reachedTestPercent: number;
  readonly typecheckReachedTestFiles: number;
  readonly remediation: TestingDiagnoseRemediation;
};

export type TestingFallbackTrap = {
  readonly kind: string;
  readonly prefix: string;
  readonly fileCount: number;
  readonly samplePaths: readonly string[];
  readonly project?: string;
  readonly remediation: TestingDiagnoseRemediation;
};

export type TestingDiagnoseResult = {
  readonly schemaVersion: 1;
  readonly summary: TestingDiagnoseSummary;
  readonly workspaceUncertainties: readonly TestingWideningCulprit[];
  readonly wideningCulprits: readonly TestingWideningCulprit[];
  readonly couplingHotspots: readonly TestingCouplingHotspot[];
  readonly fallbackTraps: readonly TestingFallbackTrap[];
};

type NativeOperation = "plan" | "run" | "diagnose" | "expand-manifest";

type NativeResponse = {
  readonly schemaVersion: number;
  readonly ok: boolean;
  readonly result?: {
    readonly operation: NativeOperation;
    readonly plan: TestingPlanResult;
    readonly run?: TestingRunResult;
    readonly diagnose?: TestingDiagnoseResult;
    readonly manifest?: unknown;
  };
  readonly error?: string;
};

type NativeRequest = {
  readonly schemaVersion: number;
  readonly operation: NativeOperation;
  readonly workspaceRoot: string;
  readonly manifestPath?: string;
  readonly base?: string;
  readonly head?: string;
  readonly all: boolean;
  readonly only?: boolean;
  readonly taskIds: readonly string[];
  readonly taskKinds?: readonly string[];
  readonly targets?: readonly string[];
  readonly projects?: readonly string[];
  readonly excludeProjects?: readonly string[];
  readonly shard?: TestingTaskShard;
  readonly shardWeights?: Readonly<Record<string, number>>;
  readonly jobs?: number;
  readonly cache?: boolean;
  readonly remoteCacheUrl?: string;
  readonly stream?: boolean;
};

export async function planTesting(request: TestingOperationRequest): Promise<TestingPlanResult> {
  const response = await invokeNativeTestingEngine("plan", request);
  return response.plan;
}

export async function runTesting(request: TestingOperationRequest): Promise<{
  readonly plan: TestingPlanResult;
  readonly run: TestingRunResult;
}> {
  const response = await invokeNativeTestingEngine("run", request);
  if (!response.run) {
    throw new Error("The native testing engine returned a run response without run details.");
  }
  return { plan: response.plan, run: response.run };
}

export async function diagnoseTesting(request: TestingDiagnoseRequest): Promise<TestingDiagnoseResult> {
  const response = await invokeNativeTestingEngine("diagnose", request);
  if (!response.diagnose) {
    throw new Error("The native testing engine returned a diagnose response without diagnose details.");
  }
  return response.diagnose;
}

export async function expandTestingManifest(request: TestingExpandManifestRequest): Promise<TestingManifest> {
  const response = await invokeNativeTestingEngine("expand-manifest", request);
  if (response.manifest === undefined) {
    throw new Error("The native testing engine returned an expand-manifest response without a manifest.");
  }
  return parseTestingManifest(JSON.stringify(response.manifest), request.manifestPath ?? "dads.testing.json");
}

async function invokeNativeTestingEngine(
  operation: NativeOperation,
  request: TestingOperationRequest,
): Promise<NonNullable<NativeResponse["result"]>> {
  const nativeRequest = toNativeRequest(operation, request);
  const response = await runNativeProcess(
    resolveNativeTestingBinary(request.nativeBinary === undefined ? {} : { explicitBinary: request.nativeBinary })
      .binary,
    nativeRequest,
    request.stream === true ? request.onStream : undefined,
  );
  return requireResultFor(response, operation);
}

/** An absent field is omitted rather than sent as null, which the engine refuses. */
function toNativeRequest(operation: NativeOperation, request: TestingOperationRequest): NativeRequest {
  return {
    schemaVersion: protocolSchemaVersion,
    operation,
    workspaceRoot: resolve(request.workspaceRoot),
    all: request.all ?? false,
    taskIds: request.taskIds ?? [],
    ...optionalNativeScopeFields(request),
    ...optionalNativeFilterFields(request),
    ...optionalNativeRunFields(request),
  };
}

function optionalNativeScopeFields(request: TestingOperationRequest): Partial<NativeRequest> {
  return {
    ...(request.manifestPath === undefined ? {} : { manifestPath: request.manifestPath }),
    ...(request.base === undefined ? {} : { base: request.base }),
    ...(request.head === undefined ? {} : { head: request.head }),
    ...(request.only === true ? { only: true } : {}),
    ...(request.taskKinds === undefined || request.taskKinds.length === 0 ? {} : { taskKinds: request.taskKinds }),
    ...(request.shard === undefined ? {} : { shard: request.shard }),
  };
}

function optionalNativeFilterFields(request: TestingOperationRequest): Partial<NativeRequest> {
  return {
    ...(request.targets === undefined || request.targets.length === 0 ? {} : { targets: request.targets }),
    ...(request.projects === undefined || request.projects.length === 0 ? {} : { projects: request.projects }),
    ...(request.excludeProjects === undefined || request.excludeProjects.length === 0
      ? {}
      : { excludeProjects: request.excludeProjects }),
    ...(request.shardWeights === undefined || Object.keys(request.shardWeights).length === 0
      ? {}
      : { shardWeights: request.shardWeights }),
  };
}

function optionalNativeRunFields(request: TestingOperationRequest): Partial<NativeRequest> {
  return {
    ...(request.jobs === undefined ? {} : { jobs: request.jobs }),
    ...(request.cache === true ? { cache: true } : {}),
    ...(request.remoteCacheUrl === undefined ? {} : { remoteCacheUrl: request.remoteCacheUrl }),
    ...(request.stream === true ? { stream: true } : {}),
  };
}

/**
 * Every way the envelope can fail to carry the result asked for is an error
 * here, so a caller only ever sees a result for the operation it requested.
 */
function requireResultFor(response: NativeResponse, operation: NativeOperation): NonNullable<NativeResponse["result"]> {
  if (response.schemaVersion !== protocolSchemaVersion) {
    throw new Error(`Unsupported native response schemaVersion ${String(response.schemaVersion)}.`);
  }
  if (!response.ok || !response.result) {
    throw new Error(response.error ?? "The native testing engine failed without an error message.");
  }
  if (response.result.operation !== operation) {
    throw new Error(`The native testing engine returned ${response.result.operation} for ${operation}.`);
  }
  return response.result;
}

async function runNativeProcess(
  nativeBinary: string,
  request: NativeRequest,
  onStream?: (chunk: string) => void,
): Promise<NativeResponse> {
  return new Promise<NativeResponse>((resolveResponse, reject) => {
    const child = spawn(nativeBinary, [], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdout.push(chunk));
    child.stderr.on("data", (chunk: string) => {
      stderr.push(chunk);
      if (onStream !== undefined) onStream(chunk);
    });
    child.once("error", (error: Error) => {
      reject(error);
    });
    child.once("close", () => {
      const rawResponse = stdout.join("").trim();
      try {
        const parsed: unknown = JSON.parse(rawResponse);
        if (!isNativeResponse(parsed)) {
          reject(new Error("The native testing engine returned an invalid response."));
          return;
        }
        resolveResponse(parsed);
      } catch (error: unknown) {
        const detail = stderr.join("").trim();
        reject(
          new Error(
            detail.length > 0
              ? `The native testing engine did not return JSON: ${detail}`
              : `The native testing engine did not return JSON: ${error instanceof Error ? error.message : "unknown parse error"}`,
          ),
        );
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function isNativeResponse(value: unknown): value is NativeResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    "ok" in value &&
    typeof value.schemaVersion === "number" &&
    typeof value.ok === "boolean"
  );
}
