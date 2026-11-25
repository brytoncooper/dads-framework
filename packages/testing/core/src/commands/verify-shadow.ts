import { runTesting } from "../testing-api.js";
import type {
  TestingOperationRequest,
  TestingPlanResult,
  TestingRunResult,
  TestingUndeclaredRead,
} from "../testing-api.js";

export type ShadowEscapedFailure = {
  readonly taskId: string;
  readonly status: string;
  readonly exitCode: number | null;
};

export type ShadowUndeclaredRead = {
  readonly taskId: string;
  readonly path: string;
  readonly location?: string;
  readonly api?: string;
};

export type ShadowVerificationReceipt = {
  readonly skipped: number;
  readonly verifiedSkipped: number;
  readonly escapedFailures: readonly ShadowEscapedFailure[];
  readonly undeclaredReads: readonly ShadowUndeclaredRead[];
  readonly reductionRatio: number;
  readonly strict: boolean;
};

export type ShadowVerificationOptions = {
  readonly strict: boolean;
  readonly stream?: boolean;
  readonly onStream?: (chunk: string) => void;
};

/**
 * Runs every task skipped as `skip-proven-unaffected` in a fresh uncached shadow
 * pass and produces a structured trust receipt proving zero escaped failures.
 */
export async function runShadowVerification(
  request: TestingOperationRequest,
  primary: { readonly plan: TestingPlanResult; readonly run: TestingRunResult },
  options: ShadowVerificationOptions,
): Promise<ShadowVerificationReceipt> {
  const skippedTaskIds = primary.plan.tasks
    .filter((task) => task.decision === "skip-proven-unaffected")
    .map((task) => task.id);
  const totalTasks = primary.plan.tasks.length;
  const reductionRatio = totalTasks === 0 ? 0 : Number((skippedTaskIds.length / totalTasks).toFixed(4));

  if (skippedTaskIds.length === 0) {
    return {
      skipped: 0,
      verifiedSkipped: 0,
      escapedFailures: [],
      undeclaredReads: [],
      reductionRatio,
      strict: options.strict,
    };
  }

  const shadowResult = await runTesting(buildShadowRequest(request, skippedTaskIds, options));
  return summarizeShadowOutcomes(skippedTaskIds, shadowResult.run, reductionRatio, options.strict);
}

function buildShadowRequest(
  request: TestingOperationRequest,
  skippedTaskIds: readonly string[],
  options: ShadowVerificationOptions,
): TestingOperationRequest {
  return {
    workspaceRoot: request.workspaceRoot,
    ...(request.manifestPath === undefined ? {} : { manifestPath: request.manifestPath }),
    ...(request.nativeBinary === undefined ? {} : { nativeBinary: request.nativeBinary }),
    ...(request.jobs === undefined ? {} : { jobs: request.jobs }),
    ...(request.enforceDeclaredReads === true ? { enforceDeclaredReads: true } : {}),
    ...(request.noEnforceDeclaredReads === true ? { noEnforceDeclaredReads: true } : {}),
    all: false,
    only: true,
    cache: false,
    taskIds: skippedTaskIds,
    ...(options.stream === true ? { stream: true } : {}),
    ...(options.onStream === undefined ? {} : { onStream: options.onStream }),
  };
}

function summarizeShadowOutcomes(
  skippedTaskIds: readonly string[],
  run: TestingRunResult,
  reductionRatio: number,
  strict: boolean,
): ShadowVerificationReceipt {
  const skippedSet = new Set(skippedTaskIds);
  let verifiedSkipped = 0;
  const escapedFailures: ShadowEscapedFailure[] = [];
  const undeclaredReads: ShadowUndeclaredRead[] = [];

  for (const task of run.tasks) {
    if (!skippedSet.has(task.id)) continue;
    for (const read of task.undeclaredReads ?? []) {
      undeclaredReads.push(toShadowUndeclaredRead(task.id, read));
    }
    if (task.status === "executed" || task.status === "not-applicable") {
      verifiedSkipped += 1;
    } else {
      escapedFailures.push({
        taskId: task.id,
        status: task.status,
        exitCode: task.exitCode ?? null,
      });
    }
  }

  return {
    skipped: skippedTaskIds.length,
    verifiedSkipped,
    escapedFailures,
    undeclaredReads,
    reductionRatio,
    strict,
  };
}

function toShadowUndeclaredRead(taskId: string, read: TestingUndeclaredRead): ShadowUndeclaredRead {
  return {
    taskId,
    path: read.path,
    ...(read.location === undefined ? {} : { location: read.location }),
    ...(read.api === undefined ? {} : { api: read.api }),
  };
}

export function renderShadowVerification(receipt: ShadowVerificationReceipt): string {
  const pct = (receipt.reductionRatio * 100).toFixed(1);
  const lines = [
    `shadow-verify: ${String(receipt.verifiedSkipped)}/${String(receipt.skipped)} skipped tasks passed, ${String(receipt.escapedFailures.length)} escaped failures, ${String(receipt.undeclaredReads.length)} undeclared reads (reduction ${pct}%).`,
  ];
  for (const failure of receipt.escapedFailures) {
    lines.push(
      `  ESCAPE ${failure.taskId}: status=${failure.status} exitCode=${failure.exitCode === null ? "null" : String(failure.exitCode)}`,
    );
  }
  for (const read of receipt.undeclaredReads) {
    const loc = read.location === undefined ? "" : ` (${read.location})`;
    lines.push(`  UNDECLARED ${read.taskId}: ${read.path}${loc}`);
  }
  return `${lines.join("\n")}\n`;
}
