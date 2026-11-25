export type TestingTaskShard = {
  readonly index: number;
  readonly total: number;
};

export type TestingPlanShard = {
  readonly index: number;
  readonly total: number;
  readonly weighted: boolean;
  readonly totalProjects: number;
  readonly selectedProjects: number;
  readonly totalRunnableTasks: number;
  readonly selectedRunnableTasks: number;
  readonly shardWeight: number;
  readonly totalWeight: number;
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
  /** Optional local disk cache directory (`--cache-dir` or `DAD_TEST_CACHE_DIR`), safely shared across worktrees. */
  readonly cacheDir?: string;
  /** Optional L2 remote receipt store URL (`file://`, `http://`, `https://`, or `s3://`). */
  readonly remoteCacheUrl?: string;
  /** Stream live task progress to stderr during `run`. */
  readonly stream?: boolean;
  /** Optional path to a precomputed `dad-test plan --json` file reused by `run`. */
  readonly planFile?: string;
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
  /** Shard partition metadata, present when `--shard` was requested. */
  readonly shard?: TestingPlanShard;
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

export type TestingCheckBoundariesRequest = {
  readonly workspaceRoot: string;
  readonly manifestPath?: string;
  readonly base?: string;
  readonly head?: string;
  readonly boundariesConfigPath?: string;
  /** An explicit native binary is intended for local development and test harnesses. */
  readonly nativeBinary?: string;
};

export type TestingBoundaryViolation = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly sourceProject: string;
  readonly targetProject?: string;
  readonly specifier: string;
  readonly rule: string;
  readonly message: string;
};

export type TestingBoundariesResult = {
  readonly schemaVersion: 1;
  readonly checkedFiles: number;
  readonly totalProjects: number;
  readonly violations: readonly TestingBoundaryViolation[];
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
