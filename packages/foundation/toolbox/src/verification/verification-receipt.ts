import { isRecord, isString, isUnknownArray } from "../parse-guards.js";
import { sha256 } from "./canonical-bytes.js";
import type {
  VerificationInputIdentity,
  VerificationInputRole,
} from "./verification-inputs.js";
import { assertVerificationInputIdentity } from "./verification-inputs.js";

export type VerificationOutputFingerprint = {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
};

export type ControlledVerificationExecution = {
  readonly snapshotId: string;
  readonly identity: VerificationInputIdentity;
  readonly status: "succeeded" | "failed";
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly failure: string | undefined;
  readonly outputs: readonly VerificationOutputFingerprint[];
};

export type SuccessfulVerificationReceipt = {
  readonly formatVersion: 1;
  readonly projectId: string;
  readonly taskId: string;
  readonly snapshotId: string;
  readonly identity: VerificationInputIdentity;
  readonly outputs: readonly VerificationOutputFingerprint[];
  readonly completedAt: string;
  readonly receiptId: string;
};

export function createSuccessfulVerificationReceipt(
  execution: ControlledVerificationExecution,
  completedAt = new Date().toISOString(),
): SuccessfulVerificationReceipt {
  assertSuccessfulExecution(execution);
  assertCompletedAt(completedAt);
  const receiptWithoutId: Omit<SuccessfulVerificationReceipt, "receiptId"> = {
    formatVersion: 1,
    projectId: execution.identity.projectId,
    taskId: execution.identity.taskId,
    snapshotId: execution.snapshotId,
    identity: execution.identity,
    outputs: execution.outputs,
    completedAt,
  };
  return {
    ...receiptWithoutId,
    receiptId: sha256(JSON.stringify(receiptWithoutId)),
  };
}

/** The receipt fields that name what was verified, read before the body is rebuilt. */
type VerificationReceiptScope = {
  readonly projectId: string;
  readonly taskId: string;
  readonly snapshotId: string;
  readonly completedAt: string;
  readonly receiptId: string;
};

export function parseSuccessfulVerificationReceipt(
  input: unknown,
): SuccessfulVerificationReceipt {
  if (!isRecord(input) || input["formatVersion"] !== 1) {
    throw new Error("Invalid verification receipt format.");
  }
  const serialized = JSON.stringify(input);
  const scope = readReceiptScope(input);
  const parsedWithoutId: Omit<SuccessfulVerificationReceipt, "receiptId"> = {
    formatVersion: 1,
    projectId: scope.projectId,
    taskId: scope.taskId,
    snapshotId: scope.snapshotId,
    identity: parseIdentity(input["identity"]),
    outputs: parseOutputs(input["outputs"]),
    completedAt: scope.completedAt,
  };
  if (sha256(JSON.stringify(parsedWithoutId)) !== scope.receiptId) {
    throw new Error(
      "Verification receipt checksum does not match its contents.",
    );
  }
  const parsed = { ...parsedWithoutId, receiptId: scope.receiptId };
  if (JSON.stringify(parsed) !== serialized) {
    throw new Error(
      "Verification receipt contains unsupported fields or ordering.",
    );
  }
  assertReceiptScopeMatchesIdentity(parsed);
  assertReceiptOutputs(parsed.identity, parsed.outputs);
  assertCompletedAt(parsed.completedAt);
  return parsed;
}

function readReceiptScope(
  input: Record<string, unknown>,
): VerificationReceiptScope {
  return {
    projectId: readReceiptString(input, "projectId"),
    taskId: readReceiptString(input, "taskId"),
    snapshotId: readHash(input, "snapshotId"),
    completedAt: readReceiptString(input, "completedAt"),
    receiptId: readHash(input, "receiptId"),
  };
}

function assertReceiptScopeMatchesIdentity(
  receipt: SuccessfulVerificationReceipt,
): void {
  if (
    receipt.identity.projectId !== receipt.projectId ||
    receipt.identity.taskId !== receipt.taskId ||
    receipt.identity.snapshotId !== receipt.snapshotId
  ) {
    throw new Error("Verification receipt identity does not match its scope.");
  }
}

function parseIdentity(input: unknown): VerificationInputIdentity {
  if (!isRecord(input) || input["formatVersion"] !== 1) {
    throw new Error("Invalid verification input identity.");
  }
  const filesInput = input["files"];
  const outputFilesInput = input["outputFiles"];
  const environmentNamesInput = input["environmentNames"];
  const prerequisitesInput = input["prerequisiteIdentities"];
  const commandInput = input["command"];
  if (
    !Array.isArray(filesInput) ||
    !Array.isArray(outputFilesInput) ||
    !Array.isArray(environmentNamesInput) ||
    !Array.isArray(prerequisitesInput) ||
    !isRecord(commandInput)
  ) {
    throw new Error("Invalid verification input identity fields.");
  }
  const identity: VerificationInputIdentity = {
    formatVersion: 1,
    projectId: readReceiptString(input, "projectId"),
    taskId: readReceiptString(input, "taskId"),
    command: {
      executable: readReceiptString(commandInput, "executable"),
      entrypoint: readReceiptString(commandInput, "entrypoint"),
      arguments: readReceiptStringArray(commandInput, "arguments"),
      workingDirectory: readReceiptString(commandInput, "workingDirectory"),
    },
    runnerVersion: readReceiptString(input, "runnerVersion"),
    verifierSha256: readHash(input, "verifierSha256"),
    files: filesInput.map((file) => {
      if (!isRecord(file)) throw new Error("Invalid receipt input file.");
      const role = readReceiptString(file, "role");
      if (!isInputRole(role)) throw new Error("Invalid receipt input role.");
      return {
        path: readReceiptString(file, "path"),
        role,
        sha256: readHash(file, "sha256"),
        bytes: readNumber(file, "bytes"),
      };
    }),
    outputFiles: readReceiptStringArray(input, "outputFiles"),
    environmentNames: readReceiptStringArray(input, "environmentNames"),
    environmentSha256: readHash(input, "environmentSha256"),
    prerequisiteIdentities: readReceiptStringArray(
      input,
      "prerequisiteIdentities",
    ),
    platform: readReceiptString(input, "platform"),
    architecture: readReceiptString(input, "architecture"),
    nodeVersion: readReceiptString(input, "nodeVersion"),
    nodeExecutableSha256: readHash(input, "nodeExecutableSha256"),
    timeoutMilliseconds: readNumber(input, "timeoutMilliseconds"),
    snapshotId: readHash(input, "snapshotId"),
  };
  assertVerificationInputIdentity(identity);
  return identity;
}

function parseOutputs(
  input: unknown,
): readonly VerificationOutputFingerprint[] {
  if (!Array.isArray(input)) throw new Error("Invalid verification outputs.");
  return input.map((output) => {
    if (!isRecord(output)) throw new Error("Invalid verification output.");
    return {
      path: readReceiptString(output, "path"),
      sha256: readHash(output, "sha256"),
      bytes: readNumber(output, "bytes"),
    };
  });
}

/**
 * A receipt field read as a non-empty string. A receipt has no field an empty
 * string could answer, so emptiness is a parse failure here — unlike
 * `readString` in `verification-policy-parsing.ts`, which permits it.
 */
function readReceiptString(
  input: Record<string, unknown>,
  field: string,
): string {
  const fieldValue = input[field];
  if (typeof fieldValue !== "string" || fieldValue.length === 0) {
    throw new Error(`Verification receipt ${field} must be a string.`);
  }
  return fieldValue;
}

function readHash(input: Record<string, unknown>, field: string): string {
  const fieldValue = readReceiptString(input, field);
  if (!/^[a-f0-9]{64}$/.test(fieldValue)) {
    throw new Error(`Verification receipt ${field} must be a SHA-256 hash.`);
  }
  return fieldValue;
}

function readNumber(input: Record<string, unknown>, field: string): number {
  const fieldValue = input[field];
  if (
    typeof fieldValue !== "number" ||
    !Number.isSafeInteger(fieldValue) ||
    fieldValue < 0
  ) {
    throw new Error(`Verification receipt ${field} must be a safe number.`);
  }
  return fieldValue;
}

/** A receipt field read as an array of non-empty strings. */
function readReceiptStringArray(
  input: Record<string, unknown>,
  field: string,
): readonly string[] {
  const fieldValue = input[field];
  if (!isUnknownArray(fieldValue)) {
    throw new Error(`Verification receipt ${field} must be a string array.`);
  }
  return fieldValue.map((entry) => {
    if (!isString(entry) || entry.length === 0) {
      throw new Error(`Verification receipt ${field} must be a string array.`);
    }
    return entry;
  });
}

function assertSuccessfulExecution(
  execution: ControlledVerificationExecution,
): void {
  if (
    execution.status !== "succeeded" ||
    execution.exitCode !== 0 ||
    execution.signal !== null ||
    execution.failure !== undefined
  ) {
    throw new Error(
      "Failed verification cannot create a receipt; a successful execution requires exit code zero.",
    );
  }
  if (execution.snapshotId !== execution.identity.snapshotId) {
    throw new Error(
      "Successful execution does not match its snapshot identity.",
    );
  }
  assertVerificationInputIdentity(execution.identity);
  assertReceiptOutputs(execution.identity, execution.outputs);
}

function assertReceiptOutputs(
  identity: VerificationInputIdentity,
  outputs: readonly VerificationOutputFingerprint[],
): void {
  const outputPaths = outputs.map((output) => output.path);
  if (JSON.stringify(outputPaths) !== JSON.stringify(identity.outputFiles)) {
    throw new Error(
      "Verification receipt does not contain every required output.",
    );
  }
  for (const output of outputs) {
    if (!/^[a-f0-9]{64}$/.test(output.sha256)) {
      throw new Error("Verification output fingerprint is not a SHA-256 hash.");
    }
    if (!Number.isSafeInteger(output.bytes) || output.bytes < 0) {
      throw new Error("Verification output byte count is invalid.");
    }
  }
}

function assertCompletedAt(completedAt: string): void {
  const parsedTime = Date.parse(completedAt);
  if (
    !Number.isFinite(parsedTime) ||
    new Date(parsedTime).toISOString() !== completedAt
  ) {
    throw new Error(
      "Verification receipt completedAt must be an ISO timestamp.",
    );
  }
}

function isInputRole(value: string): value is VerificationInputRole {
  return [
    "source",
    "test",
    "configuration",
    "resolved-dependency",
    "artifact",
  ].includes(value);
}
