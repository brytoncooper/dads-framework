import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  toNativeHotspotsOptions,
  type NativeHotspotsOptions,
  type TestingHotspotsRequest,
  type TestingHotspotsResult,
} from "./hotspots-types.js";
import { resolveNativeTestingBinary } from "./native-platform.js";
import { parseTestingManifest, type TestingManifest } from "./testing-manifest.js";

export type {
  TestingHotspotFile,
  TestingHotspotProject,
  TestingHotspotsRequest,
  TestingHotspotsResult,
  TestingHotspotsSummary,
} from "./hotspots-types.js";

import type {
  TestingBoundariesResult,
  TestingCheckBoundariesRequest,
  TestingDiagnoseRequest,
  TestingDiagnoseResult,
  TestingExpandManifestRequest,
  TestingOperationRequest,
  TestingPlanResult,
  TestingRunResult,
  TestingTaskShard,
} from "./testing-api-types.js";

export type * from "./testing-api-types.js";

const protocolSchemaVersion = 1;

type NativeOperation = "plan" | "run" | "diagnose" | "hotspots" | "expand-manifest" | "check-boundaries";

type NativeResponse = {
  readonly schemaVersion: number;
  readonly ok: boolean;
  readonly result?: {
    readonly operation: NativeOperation;
    readonly plan: TestingPlanResult;
    readonly run?: TestingRunResult;
    readonly diagnose?: TestingDiagnoseResult;
    readonly hotspots?: TestingHotspotsResult;
    readonly manifest?: unknown;
    readonly boundaries?: TestingBoundariesResult;
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
  readonly cacheDir?: string;
  readonly remoteCacheUrl?: string;
  readonly stream?: boolean;
  readonly planFile?: string;
  readonly enforceDeclaredReads?: boolean;
  readonly noEnforceDeclaredReads?: boolean;
  readonly auditReads?: boolean;
  readonly readGuardHookPath?: string;
  readonly hotspots?: NativeHotspotsOptions;
  readonly boundariesConfigPath?: string;
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

export async function hotspotsTesting(request: TestingHotspotsRequest): Promise<TestingHotspotsResult> {
  const response = await invokeNativeTestingEngine("hotspots", request, toNativeHotspotsOptions(request));
  if (!response.hotspots) {
    throw new Error("The native testing engine returned a hotspots response without hotspots details.");
  }
  return response.hotspots;
}

export async function expandTestingManifest(request: TestingExpandManifestRequest): Promise<TestingManifest> {
  const response = await invokeNativeTestingEngine("expand-manifest", request);
  if (response.manifest === undefined) {
    throw new Error("The native testing engine returned an expand-manifest response without a manifest.");
  }
  return parseTestingManifest(JSON.stringify(response.manifest), request.manifestPath ?? "dads.testing.json");
}

export async function checkTestingBoundaries(request: TestingCheckBoundariesRequest): Promise<TestingBoundariesResult> {
  const response = await invokeNativeTestingEngine("check-boundaries", request);
  if (!response.boundaries) {
    throw new Error("The native testing engine returned a check-boundaries response without boundary details.");
  }
  return response.boundaries;
}

type NativeInvocationRequest = TestingOperationRequest & {
  readonly boundariesConfigPath?: string;
};

async function invokeNativeTestingEngine(
  operation: NativeOperation,
  request: NativeInvocationRequest,
  hotspots?: NativeHotspotsOptions,
): Promise<NonNullable<NativeResponse["result"]>> {
  const nativeRequest = toNativeRequest(operation, request, hotspots);
  const response = await runNativeProcess(
    resolveNativeTestingBinary(request.nativeBinary === undefined ? {} : { explicitBinary: request.nativeBinary })
      .binary,
    nativeRequest,
    request.stream === true ? request.onStream : undefined,
  );
  return requireResultFor(response, operation);
}

/** An absent field is omitted rather than sent as null, which the engine refuses. */
function toNativeRequest(
  operation: NativeOperation,
  request: NativeInvocationRequest,
  hotspots?: NativeHotspotsOptions,
): NativeRequest {
  return {
    schemaVersion: protocolSchemaVersion,
    operation,
    workspaceRoot: resolve(request.workspaceRoot),
    all: request.all ?? false,
    taskIds: request.taskIds ?? [],
    ...optionalNativeScopeFields(request),
    ...optionalNativeFilterFields(request),
    ...optionalNativeRunFields(request),
    ...(hotspots === undefined ? {} : { hotspots }),
    ...(request.boundariesConfigPath === undefined ? {} : { boundariesConfigPath: request.boundariesConfigPath }),
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
    ...(request.cacheDir === undefined ? {} : { cacheDir: request.cacheDir }),
    ...(request.remoteCacheUrl === undefined ? {} : { remoteCacheUrl: request.remoteCacheUrl }),
    ...(request.stream === true ? { stream: true } : {}),
    ...(request.planFile === undefined ? {} : { planFile: request.planFile }),
    ...optionalNativeReadGuardFields(request),
  };
}

function optionalNativeReadGuardFields(request: TestingOperationRequest): Partial<NativeRequest> {
  return {
    ...(request.enforceDeclaredReads === true ? { enforceDeclaredReads: true } : {}),
    ...(request.noEnforceDeclaredReads === true ? { noEnforceDeclaredReads: true } : {}),
    ...(request.auditReads === true ? { auditReads: true } : {}),
    ...(request.readGuardHookPath === undefined ? {} : { readGuardHookPath: request.readGuardHookPath }),
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
