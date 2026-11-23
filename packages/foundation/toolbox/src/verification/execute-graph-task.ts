/**
 * One task of a verification graph, from prerequisite check to recorded result.
 *
 * A shell task simply runs. A controlled task is captured, checked against its
 * providers, offered existing evidence, and only then executed — and every exit
 * from that path produces the same shape of result, so the graph above can
 * treat "ran", "reused" and "refused" alike.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { decideTaskReuse } from "./logic/decide-task-reuse.js";
import {
  assertConsumedArtifactsMatchProviders,
  outputIdentity,
  publishTaskOutputs,
} from "./publish-verification-outputs.js";
import {
  createVerificationReceiptStore,
  findSuccessfulVerificationReceipt,
  publishSuccessfulVerificationReceipt,
  type VerificationReceiptLookup,
  type VerificationReceiptStore,
} from "./receipt-store.js";
import { runCapturedVerification, runVerificationTask } from "./run-verification-task.js";
import { errorMessage } from "./verification-failure.js";
import type {
  ControlledVerificationTask,
  VerificationTaskDefinition,
  VerificationTaskRecommendation,
  VerificationTaskResult,
} from "./verification-contract.js";
import {
  captureVerificationSnapshot,
  capturedSnapshotMatchesProject,
  discardVerificationSnapshot,
  type CapturedVerificationSnapshot,
  type ControlledVerificationRequest,
} from "./verification-inputs.js";
import type { ControlledVerificationExecution, VerificationOutputFingerprint } from "./verification-receipt.js";
import type { VerifyTaskGraphRequest } from "./verify-task-graph.js";

/** One task and everything already known about the run it belongs to. */
export type GraphTaskExecution = {
  readonly request: VerifyTaskGraphRequest;
  readonly task: VerificationTaskDefinition;
  readonly recommendation: VerificationTaskRecommendation;
  readonly resultsByTask: ReadonlyMap<string, VerificationTaskResult>;
  readonly outputsByTask: ReadonlyMap<string, readonly VerificationOutputFingerprint[]>;
};

type ControlledTaskExecution = Omit<GraphTaskExecution, "task"> & {
  readonly task: ControlledVerificationTask;
};

export function verifyTask(input: GraphTaskExecution): VerificationTaskResult {
  const failedDependencies = input.recommendation.dependsOn.filter((taskId) => {
    const status = input.resultsByTask.get(taskId)?.status;
    return status !== "executed" && status !== "reused";
  });
  if (failedDependencies.length > 0) {
    return blockedResult(
      input.recommendation,
      `Blocked by unsuccessful prerequisite ${failedDependencies.join(", ")}.`,
    );
  }
  if (input.task.execution.kind === "shell") {
    return executeShellTask(input.request, input.recommendation);
  }
  return verifyControlledTask({
    ...input,
    task: { ...input.task, execution: input.task.execution },
  });
}

export function blockedResult(recommendation: VerificationTaskRecommendation, reason: string): VerificationTaskResult {
  return {
    taskId: recommendation.taskId,
    command: recommendation.command,
    status: "blocked",
    reason,
    snapshotId: undefined,
    receiptId: undefined,
    outputs: [],
  };
}

function executeShellTask(
  request: VerifyTaskGraphRequest,
  recommendation: VerificationTaskRecommendation,
): VerificationTaskResult {
  const execution = runVerificationTask(request.projectRoot, recommendation, request.captureOutput);
  return {
    taskId: recommendation.taskId,
    command: recommendation.command,
    status: execution.passed ? "executed" : "failed",
    reason: execution.passed
      ? "Shell and live verification tasks execute every time."
      : (execution.error ?? "Verification command failed."),
    snapshotId: undefined,
    receiptId: undefined,
    outputs: [],
  };
}

/** With the cache off (`CI` or `--no-cache`) no receipt is read at all. */
function lookUpReceipt(
  input: ControlledTaskExecution,
  store: VerificationReceiptStore,
  snapshotId: string,
): VerificationReceiptLookup {
  if (input.request.cacheOff === true) return { status: "missing" };
  return findSuccessfulVerificationReceipt(
    store,
    input.request.project.verificationPolicy.projectId,
    input.task.id,
    snapshotId,
  );
}

function verifyControlledTask(input: ControlledTaskExecution): VerificationTaskResult {
  let snapshot: CapturedVerificationSnapshot;
  try {
    snapshot = captureVerificationSnapshot(createControlledRequest(input.request, input.task, input.outputsByTask));
  } catch (error: unknown) {
    return failedResult(input.recommendation, errorMessage(error));
  }

  try {
    try {
      assertConsumedArtifactsMatchProviders(input.request.project, input.task, snapshot, input.outputsByTask);
    } catch (error: unknown) {
      return failedResult(input.recommendation, errorMessage(error), snapshot.identity.snapshotId);
    }
    const store = createVerificationReceiptStore(input.request.evidenceRoot ?? input.request.projectRoot);
    const projectMatchedBeforeLookup = capturedSnapshotMatchesProject(snapshot);
    const receipt = lookUpReceipt(input, store, snapshot.identity.snapshotId);
    const decision = decideTaskReuse({
      full: input.request.full,
      cacheOff: input.request.cacheOff === true,
      task: input.task,
      recommendation: input.recommendation,
      receipt,
    });
    if (decision.decision === "reuse" && receipt.status === "match") {
      if (!projectMatchedBeforeLookup || !capturedSnapshotMatchesProject(snapshot)) {
        return failedResult(
          input.recommendation,
          "Controlled inputs changed while selecting reusable evidence.",
          snapshot.identity.snapshotId,
        );
      }
      return {
        taskId: input.task.id,
        command: input.task.command,
        status: "reused",
        reason: decision.reason,
        snapshotId: receipt.receipt.snapshotId,
        receiptId: receipt.receipt.receiptId,
        outputs: receipt.receipt.outputs,
      };
    }
    if (receipt.status === "invalid") {
      discardInvalidReceipt(
        store.root,
        input.request.project.verificationPolicy.projectId,
        input.task.id,
        snapshot.identity.snapshotId,
      );
    }
    return executeControlledTask(input, snapshot, decision.reason);
  } finally {
    discardVerificationSnapshot(snapshot);
  }
}

function executeControlledTask(
  input: ControlledTaskExecution,
  snapshot: CapturedVerificationSnapshot,
  reason: string,
): VerificationTaskResult {
  const execution = runCapturedVerification(snapshot);
  if (execution.status === "failed") {
    return failedControlledResult(input.recommendation, execution);
  }
  if (!capturedSnapshotMatchesProject(snapshot)) {
    return failedResult(
      input.recommendation,
      "Controlled inputs changed while verification was running.",
      execution.snapshotId,
    );
  }
  try {
    publishTaskOutputs(input.request.projectRoot, snapshot, input.task.execution.publishOutputs);
    if (!capturedSnapshotMatchesProject(snapshot)) {
      return failedResult(
        input.recommendation,
        "Controlled inputs changed before evidence publication.",
        execution.snapshotId,
      );
    }
    const receipt = publishSuccessfulVerificationReceipt(
      createVerificationReceiptStore(input.request.evidenceRoot ?? input.request.projectRoot),
      execution,
    );
    return {
      taskId: input.task.id,
      command: input.task.command,
      status: "executed",
      reason,
      snapshotId: execution.snapshotId,
      receiptId: receipt.receiptId,
      outputs: execution.outputs,
    };
  } catch (error: unknown) {
    return failedResult(input.recommendation, errorMessage(error), execution.snapshotId);
  }
}

function createControlledRequest(
  request: VerifyTaskGraphRequest,
  task: ControlledVerificationTask,
  outputsByTask: ReadonlyMap<string, readonly VerificationOutputFingerprint[]>,
): ControlledVerificationRequest {
  return {
    executionClass: task.execution.adapter,
    projectId: request.project.verificationPolicy.projectId,
    taskId: task.id,
    projectRoot: request.projectRoot,
    workingDirectory: task.execution.workingDirectory,
    runnerEntrypoint: task.execution.runnerEntrypoint,
    runnerArguments: task.execution.runnerArguments,
    runnerVersion: task.execution.runnerVersion,
    inputFiles: task.execution.inputFiles,
    outputFiles: task.execution.outputFiles,
    environment: task.execution.environment,
    prerequisiteIdentities: [
      ...task.execution.prerequisiteOutputTaskIds.map((taskId) => outputIdentity(taskId, outputsByTask.get(taskId))),
      ...(request.gitEvidenceIdentity === undefined ? [] : [`git-evidence:${request.gitEvidenceIdentity}`]),
    ],
    timeoutMilliseconds: task.execution.timeoutMilliseconds,
  };
}

/** Evidence that failed to parse is removed, never trusted and never left to be re-read. */
function discardInvalidReceipt(receiptRoot: string, projectId: string, taskId: string, snapshotId: string): void {
  const receiptPath = join(
    receiptRoot,
    receiptPathSegment(projectId),
    receiptPathSegment(taskId),
    `${snapshotId}.json`,
  );
  if (!existsSync(receiptPath)) return;
  const status = lstatSync(receiptPath);
  if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1) {
    throw new Error("Invalid verification receipt is not a regular file.");
  }
  rmSync(receiptPath);
}

/** Names the directory an already-written receipt sits in; `receipt-store.ts` has `scopedHash` for minting one. */
function receiptPathSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function failedControlledResult(
  recommendation: VerificationTaskRecommendation,
  execution: ControlledVerificationExecution,
): VerificationTaskResult {
  return failedResult(recommendation, execution.failure ?? "Controlled verification failed.", execution.snapshotId);
}

function failedResult(
  recommendation: VerificationTaskRecommendation,
  reason: string,
  snapshotId?: string,
): VerificationTaskResult {
  return {
    taskId: recommendation.taskId,
    command: recommendation.command,
    status: "failed",
    reason,
    snapshotId,
    receiptId: undefined,
    outputs: [],
  };
}
