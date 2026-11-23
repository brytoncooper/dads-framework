import { owningProjectForPath } from "./path-ownership.js";
import { formatIssueLocation, issueScope, issueSeverity } from "./plan-issues.js";
import type {
  TestingPlanIssue,
  TestingPlanResult,
  TestingRunResult,
  TestingTaskDecision,
  TestingTaskRunResult,
} from "./testing-api.js";
import type { TestingManifest } from "./testing-manifest.js";

/**
 * A `dad-test plan`/`run` result read back to front: what the plan decided, why
 * the fallback widened (if it did), how many tasks the manifest's project
 * closure could have selected against how many it actually selected, and — when
 * a run happened — what each task did. Every count here is derived from the
 * plan, the run, and the manifest; nothing here comes from the native engine
 * directly, so an older engine's response still produces a complete report.
 */

export type ReportIssue = {
  readonly code: string;
  readonly message: string;
  readonly severity: "info" | "uncertainty" | "error";
  readonly location?: string;
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
  readonly project?: string;
};

export type TestingReport = {
  readonly schemaVersion: 1;
  readonly kind: "dads-testing-report";
  readonly scope: TestingPlanResult["scope"];
  readonly totals: {
    readonly tasks: number;
    readonly selected: number;
    readonly skipped: number;
    readonly widened: number;
    readonly byReason: Readonly<Record<string, number>>;
    readonly byConfidence: Readonly<Record<string, number>>;
  };
  readonly fallback: {
    readonly full: boolean;
    readonly forcedBy: readonly ReportIssue[];
    readonly issuesByCode: Readonly<Record<string, number>>;
    readonly issuesBySeverity: Readonly<Record<"info" | "uncertainty" | "error", number>>;
    readonly widening: readonly ReportIssue[];
  };
  readonly projectClosure: {
    readonly changedProjects: readonly string[];
    readonly unownedChangedPaths: readonly string[];
    readonly closureProjects: readonly string[];
    readonly closureTaskIds: readonly string[];
    readonly closureTaskCount: number;
    readonly selectedTaskCount: number;
    readonly reductionRatio: number | null;
  };
  readonly execution: {
    readonly tasks: readonly {
      readonly id: string;
      readonly status: TestingTaskRunResult["status"];
      readonly exitCode?: number;
      readonly durationMs?: number;
    }[];
    readonly counts: TestingRunResult["counts"];
    readonly exitCode: number;
    readonly totalTaskDurationMs: number;
    /** The engine reports no wall clock; the key stays for shape stability. */
    readonly wallClockMs: null;
  } | null;
  readonly receipts: readonly {
    readonly taskId: string;
    readonly decision: TestingTaskDecision["decision"];
    readonly reason: string;
    readonly status: TestingTaskRunResult["status"] | "planned" | "skipped";
    readonly exitCode?: number;
    readonly durationMs?: number;
  }[];
};

/** Builds the report for one `plan` (no `run`) or `run` (`plan` and `run`) result. */
export function buildTestingReport(input: {
  readonly plan: TestingPlanResult;
  readonly manifest: TestingManifest;
  readonly run?: TestingRunResult;
}): TestingReport {
  const { plan, manifest, run } = input;

  const nonInfoIssues = plan.issues.filter((issue) => issueSeverity(issue) !== "info");

  return {
    schemaVersion: 1,
    kind: "dads-testing-report",
    scope: plan.scope,
    totals: buildTotals(plan),
    fallback: {
      full: plan.scope.fullFallback,
      forcedBy: plan.scope.fullFallback
        ? nonInfoIssues.filter((issue) => issueScope(issue) === "workspace").map(toReportIssue)
        : [],
      issuesByCode: countBy(plan.issues, (issue) => issue.code),
      issuesBySeverity: buildSeverityCounts(plan.issues),
      widening: nonInfoIssues.map(toReportIssue),
    },
    projectClosure: buildProjectClosure(plan, manifest),
    execution: buildExecution(run),
    receipts: buildReceipts(plan, run),
  };
}

function buildTotals(plan: TestingPlanResult): TestingReport["totals"] {
  return {
    tasks: plan.tasks.length,
    selected: plan.tasks.filter((task) => task.decision === "run").length,
    skipped: plan.tasks.filter((task) => task.decision === "skip-proven-unaffected").length,
    widened: plan.tasks.filter((task) => task.widened).length,
    byReason: countBy(plan.tasks, (task) => task.reason),
    byConfidence: countBy(plan.tasks, (task) => task.confidence),
  };
}

/**
 * The manifest's project closure for the plan's changed paths: the changed
 * projects plus every project that transitively fallback-depends on one of
 * them. An unowned changed path, or a full-workspace `--all` plan (full
 * fallback with no changed paths to attribute), makes the closure every
 * project in the manifest — there is no narrower answer to give.
 */
function buildProjectClosure(plan: TestingPlanResult, manifest: TestingManifest): TestingReport["projectClosure"] {
  const ownedProjectIds: string[] = [];
  const unownedChangedPaths: string[] = [];
  for (const path of plan.scope.changedPaths) {
    const owner = owningProjectForPath(manifest.projects, path);
    if (owner === undefined) {
      unownedChangedPaths.push(path);
    } else {
      ownedProjectIds.push(owner.id);
    }
  }
  const changedProjects = [...new Set(ownedProjectIds)].sort();

  const needsEveryProject =
    unownedChangedPaths.length > 0 || (plan.scope.fullFallback && plan.scope.changedPaths.length === 0);
  const closureProjects = needsEveryProject
    ? manifest.projects.map((project) => project.id).sort()
    : [...closureFromChangedProjects(changedProjects, reverseFallbackDependents(manifest))].sort();

  const closureProjectSet = new Set(closureProjects);
  const closureTaskIds = manifest.tasks
    .filter((task) => closureProjectSet.has(task.project))
    .map((task) => task.id)
    .sort();

  const selectedTaskCount = plan.tasks.filter((task) => task.decision === "run").length;
  const closureTaskCount = closureTaskIds.length;

  return {
    changedProjects,
    unownedChangedPaths,
    closureProjects,
    closureTaskIds,
    closureTaskCount,
    selectedTaskCount,
    reductionRatio: closureTaskCount === 0 ? null : selectedTaskCount / closureTaskCount,
  };
}

/** Maps a project id to every project that declares it as a fallback dependency. */
function reverseFallbackDependents(manifest: TestingManifest): ReadonlyMap<string, readonly string[]> {
  const reverse = new Map<string, string[]>();
  for (const project of manifest.projects) {
    for (const dependency of project.fallbackDependencies) {
      const dependents = reverse.get(dependency) ?? [];
      dependents.push(project.id);
      reverse.set(dependency, dependents);
    }
  }
  return reverse;
}

function closureFromChangedProjects(
  changedProjects: readonly string[],
  reverse: ReadonlyMap<string, readonly string[]>,
): ReadonlySet<string> {
  const closure = new Set<string>(changedProjects);
  const pending = [...changedProjects];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    for (const dependent of reverse.get(current) ?? []) {
      if (closure.has(dependent)) continue;
      closure.add(dependent);
      pending.push(dependent);
    }
  }
  return closure;
}

function buildExecution(run: TestingRunResult | undefined): TestingReport["execution"] {
  if (run === undefined) return null;
  const tasks = run.tasks.map((task) => ({
    id: task.id,
    status: task.status,
    ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
    ...(task.durationMs === undefined ? {} : { durationMs: task.durationMs }),
  }));
  const totalTaskDurationMs = run.tasks.reduce((sum, task) => sum + (task.durationMs ?? 0), 0);
  return {
    tasks,
    counts: run.counts,
    exitCode: run.exitCode,
    totalTaskDurationMs,
    wallClockMs: null,
  };
}

/** One receipt per plan task, in plan order, merging the matching run task when there is one. */
function buildReceipts(plan: TestingPlanResult, run: TestingRunResult | undefined): TestingReport["receipts"] {
  const runTasksById = new Map((run?.tasks ?? []).map((task) => [task.id, task] as const));
  return plan.tasks.map((task) => {
    const runTask = runTasksById.get(task.id);
    const status: TestingTaskRunResult["status"] | "planned" | "skipped" =
      runTask !== undefined ? runTask.status : task.decision === "run" ? "planned" : "skipped";
    return {
      taskId: task.id,
      decision: task.decision,
      reason: task.reason,
      status,
      ...(runTask?.exitCode === undefined ? {} : { exitCode: runTask.exitCode }),
      ...(runTask?.durationMs === undefined ? {} : { durationMs: runTask.durationMs }),
    };
  });
}

function toReportIssue(issue: TestingPlanIssue): ReportIssue {
  const location = formatIssueLocation(issue);
  return {
    code: issue.code,
    message: issue.message,
    severity: issueSeverity(issue),
    ...(location === undefined ? {} : { location }),
    ...(issue.path === undefined ? {} : { path: issue.path }),
    ...(issue.line === undefined ? {} : { line: issue.line }),
    ...(issue.column === undefined ? {} : { column: issue.column }),
    ...(issue.project === undefined ? {} : { project: issue.project }),
  };
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const itemKey = key(item);
    counts[itemKey] = (counts[itemKey] ?? 0) + 1;
  }
  return counts;
}

function buildSeverityCounts(issues: readonly TestingPlanIssue[]): Record<"info" | "uncertainty" | "error", number> {
  const counts: Record<"info" | "uncertainty" | "error", number> = {
    info: 0,
    uncertainty: 0,
    error: 0,
  };
  for (const issue of issues) {
    counts[issueSeverity(issue)] += 1;
  }
  return counts;
}
