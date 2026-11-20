/**
 * The sequence a verification graph runs in.
 *
 * The live checkout is snapshotted once, every selected task runs against that
 * frozen copy in dependency order, and the checkout's identity is proved
 * unchanged before any output is published back. Running one task belongs to
 * `execute-graph-task.ts`; writing bytes out belongs to
 * `publish-verification-outputs.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DadsProject } from "../project-orientation.js";
import { parseDadsProject } from "../project-orientation.js";
import type { ChangedVerification } from "../recommend-changed-verification.js";
import { blockedResult, verifyTask } from "./execute-graph-task.js";
import { publishGraphOutputs } from "./publish-verification-outputs.js";
import { errorMessage } from "./verification-failure.js";
import type {
  VerificationGraphReport,
  VerificationReportCounts,
  VerificationTaskResult,
} from "./verification-contract.js";
import type { VerificationOutputFingerprint } from "./verification-receipt.js";
import {
  captureWorkspaceSnapshot,
  discardWorkspaceSnapshot,
  readWorkspaceIdentity,
} from "./workspace-snapshot.js";

export type VerifyTaskGraphRequest = {
  readonly projectRoot: string;
  readonly project: DadsProject;
  readonly recommendation: ChangedVerification;
  readonly full: boolean;
  /**
   * The local cache is off (`CI` set or `--no-cache`): no receipt is looked
   * up, so nothing is reused. Absent means on.
   */
  readonly cacheOff?: boolean;
  readonly captureOutput: boolean;
  readonly workspaceIdentity?: string;
  readonly gitEvidenceIdentity?: string;
  readonly evidenceRoot?: string;
};

export function verifyTaskGraph(
  request: VerifyTaskGraphRequest,
): VerificationGraphReport {
  const expectedIdentity =
    request.workspaceIdentity ?? readWorkspaceIdentity(request.projectRoot);
  let workspace;
  try {
    workspace = captureWorkspaceSnapshot(request.projectRoot, expectedIdentity);
    assertSnapshotManifest(workspace.root, request.project);
  } catch (error: unknown) {
    return createReport(request.full, [], [errorMessage(error)]);
  }
  try {
    const report = verifyCapturedTaskGraph({
      ...request,
      projectRoot: workspace.root,
      workspaceIdentity: expectedIdentity,
      ...(workspace.gitEvidenceIdentity === undefined
        ? {}
        : { gitEvidenceIdentity: workspace.gitEvidenceIdentity }),
      evidenceRoot: request.evidenceRoot ?? request.projectRoot,
    });
    if (readWorkspaceIdentity(request.projectRoot) !== expectedIdentity) {
      return createReport(request.full, report.results, [
        ...report.issues,
        "Checkout identity changed while verification was running.",
      ]);
    }
    if (report.ok) {
      publishGraphOutputs(request.projectRoot, workspace.root, request.project);
    }
    return report;
  } finally {
    discardWorkspaceSnapshot(workspace);
  }
}

function verifyCapturedTaskGraph(
  request: VerifyTaskGraphRequest,
): VerificationGraphReport {
  if (request.recommendation.tasks.length === 0) {
    return createReport(request.full, [], request.recommendation.issues);
  }
  if (!request.recommendation.complete) {
    const blocked = request.recommendation.tasks.map((task) =>
      blockedResult(
        task,
        `Verification planning is incomplete: ${request.recommendation.issues.join(" ")}`,
      ),
    );
    return createReport(request.full, blocked, request.recommendation.issues);
  }

  const taskById = new Map(
    request.project.verificationPolicy.tasks.map((task) => [task.id, task]),
  );
  const resultsByTask = new Map<string, VerificationTaskResult>();
  const outputsByTask = new Map<
    string,
    readonly VerificationOutputFingerprint[]
  >();
  const results: VerificationTaskResult[] = [];

  for (const recommendation of request.recommendation.tasks) {
    const task = taskById.get(recommendation.taskId);
    const result = task
      ? verifyTask({
          request,
          task,
          recommendation,
          resultsByTask,
          outputsByTask,
        })
      : blockedResult(
          recommendation,
          "The selected task is missing from the current verification graph.",
        );
    results.push(result);
    resultsByTask.set(result.taskId, result);
    if (result.status === "executed" || result.status === "reused") {
      outputsByTask.set(result.taskId, result.outputs);
    }
  }

  return createReport(request.full, results, request.recommendation.issues);
}

/** A snapshot that carries its own manifest must describe the graph we planned. */
function assertSnapshotManifest(
  snapshotRoot: string,
  project: DadsProject,
): void {
  const manifestPath = join(snapshotRoot, "dads.project.json");
  if (!existsSync(manifestPath)) return;
  const capturedProject = parseDadsProject(
    JSON.parse(readFileSync(manifestPath, "utf8")),
  );
  if (JSON.stringify(capturedProject) !== JSON.stringify(project)) {
    throw new Error("Captured manifest does not match the planned task graph.");
  }
}

function createReport(
  full: boolean,
  results: readonly VerificationTaskResult[],
  issues: readonly string[],
): VerificationGraphReport {
  const counts: VerificationReportCounts = {
    executed: countStatus(results, "executed"),
    reused: countStatus(results, "reused"),
    failed: countStatus(results, "failed"),
    blocked: countStatus(results, "blocked"),
    "not-applicable": results.length === 0 ? 1 : 0,
  };
  return {
    ok: counts.failed === 0 && counts.blocked === 0 && issues.length === 0,
    full,
    results,
    counts,
    issues,
  };
}

function countStatus(
  results: readonly VerificationTaskResult[],
  status: VerificationTaskResult["status"],
): number {
  return results.filter((result) => result.status === status).length;
}
