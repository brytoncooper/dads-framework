import type { DeclaredVerificationEnvironment, VerificationInputRole } from "./verification-inputs.js";
import type { VerificationOutputFingerprint } from "./verification-receipt.js";

export type VerificationTaskState = "run" | "pending-provider" | "reuse-candidate" | "unknown-scope";

export type VerificationReusePolicy = "never" | "candidate";

export type VerificationShellExecution = {
  readonly kind: "shell";
};

export type VerificationPublishedOutput = {
  readonly outputPath: string;
  readonly projectPath: string;
};

export type VerificationControlledInput = {
  readonly path: string;
  readonly role: VerificationInputRole;
};

export type VerificationControlledExecution = {
  readonly kind: "controlled-node";
  readonly adapter: "artifact-provider-v1" | "artifact-consumer-v1";
  readonly workingDirectory: string;
  readonly runnerEntrypoint: string;
  readonly runnerArguments: readonly string[];
  readonly runnerVersion: string;
  readonly inputFiles: readonly VerificationControlledInput[];
  readonly outputFiles: readonly string[];
  readonly publishOutputs: readonly VerificationPublishedOutput[];
  readonly environment: readonly DeclaredVerificationEnvironment[];
  readonly prerequisiteOutputTaskIds: readonly string[];
  readonly timeoutMilliseconds: number;
};

export type VerificationTaskExecution = VerificationShellExecution | VerificationControlledExecution;

export type VerificationTaskDefinition = {
  readonly id: string;
  readonly packageName: string;
  readonly command: string;
  readonly dependsOn: readonly string[];
  readonly sourceInputs: readonly string[];
  readonly nonSourceInputs: readonly string[];
  readonly reusePolicy: VerificationReusePolicy;
  readonly execution: VerificationTaskExecution;
};

/** A task the caller has already narrowed to controlled execution. */
export type ControlledVerificationTask = VerificationTaskDefinition & {
  readonly execution: VerificationControlledExecution;
};

export type VerificationPolicy = {
  readonly kind: "legacy" | "task-graph";
  readonly projectId: string;
  readonly tasks: readonly VerificationTaskDefinition[];
  readonly fullFallbackTaskIds: readonly string[];
};

export type VerificationTaskRecommendation = {
  readonly taskId: string;
  readonly packageName: string;
  readonly command: string;
  readonly state: VerificationTaskState;
  readonly reason: string;
  readonly dependsOn: readonly string[];
};

export type VerificationPlan = {
  readonly tasks: readonly VerificationTaskRecommendation[];
  readonly unownedPaths: readonly string[];
  readonly unknownPaths: readonly string[];
  readonly usedFullFallback: boolean;
  readonly complete: boolean;
  readonly issues: readonly string[];
};

export type VerificationTaskResultStatus = "executed" | "reused" | "failed" | "blocked" | "not-applicable";

export type VerificationTaskResult = {
  readonly taskId: string;
  readonly command: string;
  readonly status: VerificationTaskResultStatus;
  readonly reason: string;
  readonly snapshotId: string | undefined;
  readonly receiptId: string | undefined;
  readonly outputs: readonly VerificationOutputFingerprint[];
};

export type VerificationReportCounts = Readonly<Record<VerificationTaskResultStatus, number>>;

export type VerificationGraphReport = {
  readonly ok: boolean;
  readonly full: boolean;
  readonly results: readonly VerificationTaskResult[];
  readonly counts: VerificationReportCounts;
  readonly issues: readonly string[];
};
