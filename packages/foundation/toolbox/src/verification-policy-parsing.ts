/**
 * How a verification policy is read out of untyped project JSON, and what a
 * controlled task must prove about its own references before it is accepted.
 *
 * The declaration file next to this one decides what a Dads project *is*; this
 * one decides whether the verification half of that declaration holds together.
 */

import { posix } from "node:path";
import { isRecord, isString } from "./parse-guards.js";
import type {
  VerificationControlledExecution,
  VerificationReusePolicy,
  VerificationTaskExecution,
  VerificationTaskDefinition,
} from "./verification/verification-contract.js";
import type { VerificationInputRole } from "./verification/verification-inputs.js";

export function parseVerificationExecution(input: unknown): VerificationTaskExecution {
  if (!isRecord(input)) {
    throw new Error("Dads verification task execution must be an object.");
  }
  if (input["kind"] === "shell") return { kind: "shell" };
  if (input["kind"] !== "controlled-node") {
    throw new Error("Dads verification task execution kind must be shell or controlled-node.");
  }
  return parseControlledExecution(input);
}

function parseControlledExecution(input: Record<string, unknown>): VerificationControlledExecution {
  const adapter = input["adapter"];
  if (adapter !== "artifact-provider-v1" && adapter !== "artifact-consumer-v1") {
    throw new Error("Controlled verification adapter must be artifact-provider-v1 or artifact-consumer-v1.");
  }
  const timeoutMilliseconds = input["timeoutMilliseconds"];
  if (
    typeof timeoutMilliseconds !== "number" ||
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1
  ) {
    throw new Error("Controlled verification timeoutMilliseconds must be positive.");
  }
  const inputFiles = readRecordArray(input, "inputFiles").map((entry) => ({
    path: normalizeProjectPath(readNonEmptyString(entry, "path")),
    role: readVerificationInputRole(entry),
  }));
  const publishOutputs = readRecordArray(input, "publishOutputs").map((entry) => ({
    outputPath: normalizeProjectPath(readNonEmptyString(entry, "outputPath")),
    projectPath: normalizeProjectPath(readNonEmptyString(entry, "projectPath")),
  }));
  const environment = readRecordArray(input, "environment").map((entry) => {
    const secret = entry["secret"];
    if (typeof secret !== "boolean") {
      throw new Error("Controlled verification environment secret must be boolean.");
    }
    return {
      name: readNonEmptyString(entry, "name"),
      value: readString(entry, "value"),
      secret,
    };
  });
  return {
    kind: "controlled-node",
    adapter,
    workingDirectory: readNonEmptyString(input, "workingDirectory"),
    runnerEntrypoint: normalizeProjectPath(readNonEmptyString(input, "runnerEntrypoint")),
    runnerArguments: readStringArray(input, "runnerArguments"),
    runnerVersion: readNonEmptyString(input, "runnerVersion"),
    inputFiles,
    outputFiles: readStringArray(input, "outputFiles").map(normalizeProjectPath),
    publishOutputs,
    environment,
    prerequisiteOutputTaskIds: readStringArray(input, "prerequisiteOutputTaskIds"),
    timeoutMilliseconds,
  };
}

/**
 * A controlled task claims a sealed relationship with the tasks it depends on:
 * it runs one named runner from the snapshot root, consumes exactly what its
 * prerequisites publish, and matches the reuse contract its adapter promises.
 * Each of those claims is checked below in the order a reader would ask them.
 */
export function assertExecutionReferences(
  task: VerificationTaskDefinition,
  taskById: ReadonlyMap<string, VerificationTaskDefinition>,
): void {
  const execution = task.execution;
  if (execution.kind === "shell") return;
  assertControlledRunner(task, execution);
  assertOutputPrerequisites(task, execution, taskById);
  assertPublishedOutputsAreRequired(task, execution);
  assertAdapterContract(task, execution);
}

function assertControlledRunner(task: VerificationTaskDefinition, execution: VerificationControlledExecution): void {
  if (execution.workingDirectory !== ".") {
    throw new Error("Controlled verification must run from the snapshot root.");
  }
  if (execution.runnerArguments.length > 0) {
    throw new Error("Controlled verification runner arguments are not allowed.");
  }
  if (task.command !== `node ${execution.runnerEntrypoint}`) {
    throw new Error(`Controlled verification command for ${task.id} must exactly name its runner entrypoint.`);
  }
}

function assertOutputPrerequisites(
  task: VerificationTaskDefinition,
  execution: VerificationControlledExecution,
  taskById: ReadonlyMap<string, VerificationTaskDefinition>,
): void {
  const taskIds = new Set(taskById.keys());
  assertKnownTaskIds(execution.prerequisiteOutputTaskIds, taskIds, `output prerequisites for ${task.id}`);
  for (const prerequisiteTaskId of execution.prerequisiteOutputTaskIds) {
    assertOutputPrerequisite(task, execution, prerequisiteTaskId, taskById);
  }
}

function assertOutputPrerequisite(
  task: VerificationTaskDefinition,
  execution: VerificationControlledExecution,
  prerequisiteTaskId: string,
  taskById: ReadonlyMap<string, VerificationTaskDefinition>,
): void {
  if (!task.dependsOn.includes(prerequisiteTaskId)) {
    throw new Error(`Output prerequisite ${prerequisiteTaskId} must be an execution dependency of ${task.id}.`);
  }
  const prerequisiteTask = taskById.get(prerequisiteTaskId);
  if (!prerequisiteTask || prerequisiteTask.execution.kind !== "controlled-node") {
    throw new Error(`Output prerequisite ${prerequisiteTaskId} must be a controlled task.`);
  }
  for (const publishedOutput of prerequisiteTask.execution.publishOutputs) {
    const consumesPublishedArtifact = execution.inputFiles.some(
      (inputFile) => inputFile.role === "artifact" && inputFile.path === publishedOutput.projectPath,
    );
    if (!consumesPublishedArtifact) {
      throw new Error(`${task.id} must consume published output ${publishedOutput.projectPath} as an artifact.`);
    }
  }
  if (prerequisiteTask.execution.publishOutputs.length === 0) {
    throw new Error(`Output prerequisite ${prerequisiteTaskId} must publish a generated artifact.`);
  }
}

function assertPublishedOutputsAreRequired(
  task: VerificationTaskDefinition,
  execution: VerificationControlledExecution,
): void {
  for (const publishedOutput of execution.publishOutputs) {
    if (!execution.outputFiles.includes(publishedOutput.outputPath)) {
      throw new Error(`Published output ${publishedOutput.outputPath} is not required from ${task.id}.`);
    }
  }
}

/**
 * The adapter contract is the reuse contract as well. There are only two
 * adapters, and each one fixes `reusePolicy` outright: a provider is `never`,
 * a consumer is `candidate`. So the two rules a reusable task would otherwise
 * need stated on their own — it owns no published generated output, and it
 * names at least one artifact-output prerequisite — are exactly the consumer
 * clauses below, and a separate reuse check placed after this one could refuse
 * nothing this one lets through. Adding a third adapter means restating them
 * here, in that adapter's clause, rather than as a rule about `candidate`.
 */
function assertAdapterContract(task: VerificationTaskDefinition, execution: VerificationControlledExecution): void {
  if (
    execution.adapter === "artifact-provider-v1" &&
    (task.reusePolicy !== "never" ||
      execution.publishOutputs.length === 0 ||
      execution.prerequisiteOutputTaskIds.length > 0)
  ) {
    throw new Error(
      `Artifact provider ${task.id} must be non-reusable, publish output, and have no artifact prerequisite.`,
    );
  }
  if (
    execution.adapter === "artifact-consumer-v1" &&
    (task.reusePolicy !== "candidate" ||
      execution.publishOutputs.length > 0 ||
      execution.prerequisiteOutputTaskIds.length === 0)
  ) {
    throw new Error(
      `Artifact consumer ${task.id} must be reusable, consume a prerequisite, and publish no project output.`,
    );
  }
}

export function assertKnownTaskIds(
  referencedTaskIds: readonly string[],
  taskIds: ReadonlySet<string>,
  fieldDescription: string,
): void {
  for (const taskId of referencedTaskIds) {
    if (!taskIds.has(taskId)) {
      throw new Error(`${fieldDescription} references unknown task ${taskId}.`);
    }
  }
}

function readVerificationInputRole(input: Record<string, unknown>): VerificationInputRole {
  const role = input["role"];
  if (
    role !== "source" &&
    role !== "test" &&
    role !== "configuration" &&
    role !== "resolved-dependency" &&
    role !== "artifact"
  ) {
    throw new Error("Controlled verification input role is invalid.");
  }
  return role;
}

function readRecordArray(input: Record<string, unknown>, fieldName: string): readonly Record<string, unknown>[] {
  const fieldValue = input[fieldName];
  if (!Array.isArray(fieldValue) || !fieldValue.every(isRecord)) {
    throw new Error(`Dads package ${fieldName} must be an object array.`);
  }
  return fieldValue;
}

/**
 * A declared string field, empty or not. `readNonEmptyString` is the stricter
 * reader for fields that carry an identity.
 */
function readString(input: Record<string, unknown>, fieldName: string): string {
  const fieldValue = input[fieldName];
  if (typeof fieldValue !== "string") {
    throw new Error(`Dads package ${fieldName} must be a string.`);
  }
  return fieldValue;
}

export function readReusePolicy(input: Record<string, unknown>): VerificationReusePolicy {
  const reusePolicy = input["reusePolicy"];
  if (reusePolicy !== "never" && reusePolicy !== "candidate") {
    throw new Error("Dads verification task reusePolicy must be never or candidate.");
  }
  return reusePolicy;
}

export function normalizeProjectPath(value: string): string {
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new Error(`Expected a project-relative path, received ${value}.`);
  }
  return normalized.replace(/^\.\//, "").replace(/\/$/, "");
}

export function readNonEmptyString(input: Record<string, unknown>, fieldName: string): string {
  const fieldValue = input[fieldName];
  if (typeof fieldValue !== "string" || fieldValue.trim().length === 0) {
    throw new Error(`Dads package ${fieldName} must be a non-empty string.`);
  }
  return fieldValue;
}

export function readStringArray(input: Record<string, unknown>, fieldName: string): readonly string[] {
  const fieldValue = input[fieldName];
  if (!Array.isArray(fieldValue) || !fieldValue.every(isString)) {
    throw new Error(`Dads package ${fieldName} must be a string array.`);
  }
  return fieldValue;
}
