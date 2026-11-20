/**
 * What a controlled verification task is allowed to ask for, and what that
 * request is worth as an identity.
 *
 * A request is validated one rule at a time, copied so no caller can change it
 * after the fact, and turned into a snapshot identity: the digest that decides
 * whether earlier evidence still describes this exact execution. The captured
 * tree those files live in belongs to `snapshot-capture.ts`.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, compareText, sha256 } from "./canonical-bytes.js";
import {
  normalizeRelativePath,
  normalizeWorkingDirectory,
} from "./filesystem-guards.js";
import {
  assertCapturedFilesUnchanged,
  copyVerificationInputs,
  ensureVerificationWorkRoot,
  makeSnapshotReadOnly,
  projectFilesMatchCapture,
  removeCapturedTree,
  type ControlledVerificationInput,
  type VerificationInputFingerprint,
  type VerificationInputRole,
} from "./snapshot-capture.js";
import { readVerifierIdentity } from "./verifier-identity.js";

/** The captured-input vocabulary stays reachable from this module's callers. */
export type {
  ControlledVerificationInput,
  VerificationInputFingerprint,
  VerificationInputRole,
} from "./snapshot-capture.js";

export type DeclaredVerificationEnvironment = {
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
};

export type ControlledVerificationRequest = {
  readonly executionClass:
    "artifact-provider-v1" | "artifact-consumer-v1" | "live";
  readonly projectId: string;
  readonly taskId: string;
  readonly projectRoot: string;
  readonly workingDirectory: string;
  readonly runnerEntrypoint: string;
  readonly runnerArguments: readonly string[];
  readonly runnerVersion: string;
  readonly inputFiles: readonly ControlledVerificationInput[];
  readonly outputFiles: readonly string[];
  readonly environment: readonly DeclaredVerificationEnvironment[];
  readonly prerequisiteIdentities: readonly string[];
  readonly timeoutMilliseconds: number;
};

export type VerificationInputIdentity = {
  readonly formatVersion: 1;
  readonly projectId: string;
  readonly taskId: string;
  readonly command: {
    readonly executable: string;
    readonly entrypoint: string;
    readonly arguments: readonly string[];
    readonly workingDirectory: string;
  };
  readonly runnerVersion: string;
  readonly verifierSha256: string;
  readonly files: readonly VerificationInputFingerprint[];
  readonly outputFiles: readonly string[];
  readonly environmentNames: readonly string[];
  readonly environmentSha256: string;
  readonly prerequisiteIdentities: readonly string[];
  readonly platform: string;
  readonly architecture: string;
  readonly nodeVersion: string;
  readonly nodeExecutableSha256: string;
  readonly timeoutMilliseconds: number;
  readonly snapshotId: string;
};

export type CapturedVerificationSnapshot = {
  readonly projectRoot: string;
  readonly snapshotRoot: string;
  readonly outputRoot: string;
  readonly identity: VerificationInputIdentity;
  readonly environment: readonly DeclaredVerificationEnvironment[];
  readonly timeoutMilliseconds: number;
};

const fixedEnvironment = {
  LANG: "C",
  TZ: "UTC",
};

export function captureVerificationSnapshot(
  request: ControlledVerificationRequest,
): CapturedVerificationSnapshot {
  const capturedRequest = copyControlledRequest(request);
  validateControlledRequest(capturedRequest);
  const projectRoot = realpathSync(capturedRequest.projectRoot);
  const workRoot = ensureVerificationWorkRoot(projectRoot);
  const snapshotRoot = mkdtempSync(join(workRoot.snapshots, "capture-"));
  const outputRoot = mkdtempSync(join(workRoot.outputs, "output-"));

  try {
    const files = copyVerificationInputs(
      projectRoot,
      snapshotRoot,
      capturedRequest.inputFiles,
    );
    const identity = createVerificationInputIdentity(capturedRequest, files);
    makeSnapshotReadOnly(snapshotRoot);
    assertSnapshotMatchesIdentity(snapshotRoot, identity);
    return {
      projectRoot,
      snapshotRoot,
      outputRoot,
      identity,
      environment: capturedRequest.environment,
      timeoutMilliseconds: capturedRequest.timeoutMilliseconds,
    };
  } catch (error: unknown) {
    removeCapturedTree(snapshotRoot);
    rmSync(outputRoot, { force: true, recursive: true });
    throw error;
  }
}

export function assertSnapshotMatchesIdentity(
  snapshotRoot: string,
  identity: VerificationInputIdentity,
): void {
  assertVerificationInputIdentity(identity);
  assertCapturedFilesUnchanged(snapshotRoot, identity.files);
}

export function capturedSnapshotMatchesProject(
  snapshot: CapturedVerificationSnapshot,
): boolean {
  return projectFilesMatchCapture(
    snapshot.projectRoot,
    snapshot.identity.files,
  );
}

export function assertVerificationInputIdentity(
  identity: VerificationInputIdentity,
): void {
  const expectedSnapshotId = createSnapshotId(
    identityWithoutSnapshotId(identity),
  );
  if (expectedSnapshotId !== identity.snapshotId) {
    throw new Error("Verification snapshot identity checksum does not match.");
  }
}

export function discardVerificationSnapshot(
  snapshot: CapturedVerificationSnapshot,
): void {
  removeCapturedTree(snapshot.snapshotRoot);
  rmSync(snapshot.outputRoot, { force: true, recursive: true });
}

export function verificationEnvironment(
  snapshot: CapturedVerificationSnapshot,
): Readonly<Record<string, string>> {
  return {
    ...fixedEnvironment,
    ...Object.fromEntries(
      snapshot.environment.map((entry) => [entry.name, entry.value]),
    ),
    DADS_VERIFICATION_OUTPUT_DIR: snapshot.outputRoot,
    DADS_VERIFICATION_SNAPSHOT_ROOT: snapshot.snapshotRoot,
  };
}

function copyControlledRequest(
  request: ControlledVerificationRequest,
): ControlledVerificationRequest {
  return {
    ...request,
    runnerArguments: [...request.runnerArguments],
    inputFiles: request.inputFiles.map((input) => ({ ...input })),
    outputFiles: [...request.outputFiles],
    environment: request.environment.map((entry) => ({ ...entry })),
    prerequisiteIdentities: [...request.prerequisiteIdentities],
  };
}

/** Every rule a reusable request must satisfy, in the order a reader can follow. */
function validateControlledRequest(
  request: ControlledVerificationRequest,
): void {
  assertReusableExecutionClass(request);
  assertNonEmptyIdentities(request);
  assertPositiveTimeout(request);
  assertNoRunnerArguments(request);
  assertSnapshotWorkingDirectory(request);
  assertEntrypointIsDeclaredInput(request);
  assertDeclaredOutputs(request);
  assertUniqueValues(
    request.environment.map((entry) => entry.name),
    "verification environment name",
  );
  assertUniqueValues(
    request.prerequisiteIdentities,
    "verification prerequisite identity",
  );
  validateEnvironment(request);
}

function assertReusableExecutionClass(
  request: ControlledVerificationRequest,
): void {
  if (
    request.executionClass !== "artifact-provider-v1" &&
    request.executionClass !== "artifact-consumer-v1"
  ) {
    throw new Error("Live verification tasks are not eligible for reuse.");
  }
}

function assertNonEmptyIdentities(
  request: ControlledVerificationRequest,
): void {
  readNonEmptyIdentity(request.projectId, "projectId");
  readNonEmptyIdentity(request.taskId, "taskId");
  readNonEmptyIdentity(request.runnerVersion, "runnerVersion");
}

function assertPositiveTimeout(request: ControlledVerificationRequest): void {
  if (
    !Number.isSafeInteger(request.timeoutMilliseconds) ||
    request.timeoutMilliseconds < 1
  ) {
    throw new Error("Verification timeoutMilliseconds must be positive.");
  }
}

/** Arguments could address the live checkout, so a controlled runner takes none. */
function assertNoRunnerArguments(request: ControlledVerificationRequest): void {
  if (
    !request.runnerArguments.every((argument) => typeof argument === "string")
  ) {
    throw new Error("Verification runner arguments must be strings.");
  }
  if (request.runnerArguments.length > 0) {
    throw new Error(
      "Controlled verification runner arguments are not allowed.",
    );
  }
}

function assertSnapshotWorkingDirectory(
  request: ControlledVerificationRequest,
): void {
  if (request.workingDirectory !== ".") {
    throw new Error("Controlled verification must run from the snapshot root.");
  }
  normalizeWorkingDirectory(request.workingDirectory);
}

function assertEntrypointIsDeclaredInput(
  request: ControlledVerificationRequest,
): void {
  const entrypoint = normalizeRelativePath(request.runnerEntrypoint);
  const normalizedInputs = request.inputFiles.map((input) => {
    if (!isVerificationInputRole(input.role)) {
      throw new Error(
        `Unsupported verification input role ${String(input.role)}.`,
      );
    }
    return normalizeRelativePath(input.path);
  });
  if (!normalizedInputs.includes(entrypoint)) {
    throw new Error(
      "The controlled runner entrypoint must be a declared input.",
    );
  }
  assertUniqueValues(normalizedInputs, "verification input path");
}

function assertDeclaredOutputs(request: ControlledVerificationRequest): void {
  const normalizedOutputs = request.outputFiles.map(normalizeRelativePath);
  if (normalizedOutputs.length === 0) {
    throw new Error("Controlled verification must declare required outputs.");
  }
  assertUniqueValues(normalizedOutputs, "verification output path");
}

function validateEnvironment(request: ControlledVerificationRequest): void {
  const reservedNames = new Set([
    "DADS_VERIFICATION_OUTPUT_DIR",
    "DADS_VERIFICATION_SNAPSHOT_ROOT",
    "NODE_OPTIONS",
    ...Object.keys(fixedEnvironment),
  ]);
  for (const entry of request.environment) {
    if (
      typeof entry.name !== "string" ||
      typeof entry.value !== "string" ||
      typeof entry.secret !== "boolean"
    ) {
      throw new Error("Verification environment entries are invalid.");
    }
    if (!/^[A-Z_][A-Z0-9_]*$/.test(entry.name)) {
      throw new Error(`Invalid verification environment name ${entry.name}.`);
    }
    if (reservedNames.has(entry.name)) {
      throw new Error(`Verification environment ${entry.name} is reserved.`);
    }
    if (entry.secret) {
      throw new Error("Secret-dependent verification tasks are not reusable.");
    }
  }
}

function createVerificationInputIdentity(
  request: ControlledVerificationRequest,
  files: readonly VerificationInputFingerprint[],
): VerificationInputIdentity {
  const environmentNames = request.environment
    .map((entry) => entry.name)
    .sort(compareText);
  const environmentSha256 = sha256(
    canonicalJson(
      [...request.environment]
        .sort((firstEntry, secondEntry) =>
          compareText(firstEntry.name, secondEntry.name),
        )
        .map((entry) => ({ name: entry.name, value: entry.value })),
    ),
  );
  const identityWithoutSnapshot: Omit<VerificationInputIdentity, "snapshotId"> =
    {
      formatVersion: 1,
      projectId: request.projectId,
      taskId: request.taskId,
      command: {
        executable: process.execPath,
        entrypoint: normalizeRelativePath(request.runnerEntrypoint),
        arguments: [...request.runnerArguments],
        workingDirectory: normalizeWorkingDirectory(request.workingDirectory),
      },
      runnerVersion: request.runnerVersion,
      verifierSha256: readVerifierIdentity(),
      files,
      outputFiles: request.outputFiles
        .map(normalizeRelativePath)
        .sort(compareText),
      environmentNames,
      environmentSha256,
      prerequisiteIdentities: [...request.prerequisiteIdentities].sort(
        compareText,
      ),
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      nodeExecutableSha256: sha256(readFileSync(process.execPath)),
      timeoutMilliseconds: request.timeoutMilliseconds,
    };
  return {
    ...identityWithoutSnapshot,
    snapshotId: createSnapshotId(identityWithoutSnapshot),
  };
}

function identityWithoutSnapshotId(
  identity: VerificationInputIdentity,
): Omit<VerificationInputIdentity, "snapshotId"> {
  return {
    formatVersion: identity.formatVersion,
    projectId: identity.projectId,
    taskId: identity.taskId,
    command: identity.command,
    runnerVersion: identity.runnerVersion,
    verifierSha256: identity.verifierSha256,
    files: identity.files,
    outputFiles: identity.outputFiles,
    environmentNames: identity.environmentNames,
    environmentSha256: identity.environmentSha256,
    prerequisiteIdentities: identity.prerequisiteIdentities,
    platform: identity.platform,
    architecture: identity.architecture,
    nodeVersion: identity.nodeVersion,
    nodeExecutableSha256: identity.nodeExecutableSha256,
    timeoutMilliseconds: identity.timeoutMilliseconds,
  };
}

function createSnapshotId(
  identity: Omit<VerificationInputIdentity, "snapshotId">,
): string {
  return sha256(canonicalJson(identity));
}

function readNonEmptyIdentity(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Verification ${fieldName} must be non-empty.`);
  }
}

/** Refuses a repeated string; `project-orientation.ts` has `assertUniquePackageValues` for a package field. */
function assertUniqueValues(
  values: readonly string[],
  description: string,
): void {
  const uniqueValues = new Set(values);
  if (uniqueValues.size !== values.length) {
    throw new Error(`Duplicate ${description}.`);
  }
}

function isVerificationInputRole(role: unknown): role is VerificationInputRole {
  return (
    role === "source" ||
    role === "test" ||
    role === "configuration" ||
    role === "resolved-dependency" ||
    role === "artifact"
  );
}
