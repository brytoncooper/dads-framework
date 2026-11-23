import { owningProjectForPath } from "./path-ownership.js";
import { reasonTexts } from "./plan-reasons.js";
export { reasonTexts } from "./plan-reasons.js";
import { formatIssueLocation, issueScope, issueSeverity } from "./plan-issues.js";
import type { TestingPlanIssue, TestingPlanResult, TestingTaskCause, TestingTaskDecision } from "./testing-api.js";
import type { TestingManifest } from "./testing-manifest.js";

/**
 * `dad-test explain` turns a plan into the evidence behind it: for every task,
 * why it was selected or skipped, and which uncertainty widened the selection.
 *
 * A plan carries that evidence directly when the engine reports `causes`. An
 * older engine reports only a reason code, so this module reconstructs what the
 * reason implies from the plan and the manifest. The two are never mixed: the
 * explanation says which it is in `detail`, so a reader always knows whether a
 * cause was proven by the engine or inferred here.
 */

export type ExplainedIssue = {
  readonly code: string;
  readonly message: string;
  readonly location?: string;
  readonly severity: "info" | "uncertainty" | "error";
  readonly scope: "module" | "workspace" | "unknown";
  readonly project?: string;
};

export type ExplanationCause =
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
      readonly location?: string;
      readonly importedFrom: string;
      readonly symbols: readonly string[];
    }
  | { readonly kind: "issue"; readonly issue: ExplainedIssue }
  | { readonly kind: "fallback-dependency"; readonly project: string }
  | { readonly kind: "sql-object"; readonly object: string };

export type ExplainedTask = {
  readonly id: string;
  readonly project?: string;
  readonly decision: TestingTaskDecision["decision"];
  readonly reason: string;
  readonly reasonText: string;
  readonly confidence: string;
  readonly widened: boolean;
  readonly selectedFiles?: readonly string[];
  readonly causes: readonly ExplanationCause[];
};

export type PlanExplanation = {
  readonly schemaVersion: 1;
  readonly scope: TestingPlanResult["scope"];
  readonly summary: {
    readonly tasks: number;
    readonly selected: number;
    readonly skipped: number;
    readonly widened: number;
    readonly byReason: Readonly<Record<string, number>>;
    readonly fullFallback: boolean;
    readonly fullFallbackCauses: readonly ExplainedIssue[];
  };
  readonly tasks: readonly ExplainedTask[];
  readonly informational: readonly ExplainedIssue[];
  readonly detail: "engine" | "derived";
};

/**
 * Derived mode knows a task imports a changed symbol but not which one, and
 * says so rather than leaving the reader to wonder where the detail went.
 */
const derivedSymbolNote = " (symbol not reported by this dad-test build)";

/**
 * Explains a plan. The manifest is optional because `explain` must still say
 * something useful about a plan whose manifest cannot be read; without it,
 * derived mode has no project ownership and reports fewer causes.
 */
export function explainPlan(plan: TestingPlanResult, manifest?: TestingManifest): PlanExplanation {
  // One task without causes makes the whole explanation derived: mixing proven
  // and inferred causes in one report would leave `detail` meaningless.
  const detail = plan.tasks.every((task) => task.causes !== undefined) ? "engine" : "derived";
  const tasks = plan.tasks.map((task) =>
    detail === "engine" ? explainWithEngineCauses(task, plan.issues) : explainWithDerivedCauses(task, plan, manifest),
  );
  const selected = plan.tasks.filter((task) => task.decision === "run").length;

  return {
    schemaVersion: 1,
    scope: plan.scope,
    summary: {
      tasks: plan.tasks.length,
      selected,
      skipped: plan.tasks.length - selected,
      widened: plan.tasks.filter((task) => task.widened).length,
      byReason: countByReason(plan.tasks),
      fullFallback: plan.scope.fullFallback,
      fullFallbackCauses: detail === "engine" ? engineFullFallbackCauses(plan) : derivedFullFallbackCauses(plan),
    },
    tasks,
    informational: plan.issues.filter((issue) => issueSeverity(issue) === "info").map(explainIssue),
    detail,
  };
}

/**
 * Renders the explanation for a person. Every line is anchored by a leading
 * keyword and carries key=value tokens before free text, so the output is
 * greppable without being a parsing contract: `--json` is the contract.
 */
export function renderPlanExplanation(explanation: PlanExplanation): string {
  const { summary } = explanation;
  const lines: string[] = [
    `explain: ${String(summary.selected)} of ${String(summary.tasks)} tasks selected, ${String(summary.skipped)} skipped, ${String(summary.widened)} widened detail=${explanation.detail}`,
    renderScope(explanation.scope),
    `full-fallback: ${summary.fullFallback ? "yes" : "no"}`,
  ];
  if (summary.fullFallback) {
    for (const issue of summary.fullFallbackCauses) {
      lines.push(`  forced-by ${renderIssue(issue)}`);
    }
  }
  for (const task of explanation.tasks) {
    lines.push(renderTaskHeadline(task), `  because ${task.reasonText}`);
    for (const file of task.selectedFiles ?? []) lines.push(`  file ${file}`);
    for (const cause of task.causes) lines.push(`  ${renderCause(cause)}`);
  }
  for (const issue of explanation.informational) {
    lines.push(`info ${issue.code} ${issue.message}`);
  }
  return `${lines.join("\n")}\n`;
}

// --- Engine causes -------------------------------------------------------

function explainWithEngineCauses(task: TestingTaskDecision, issues: readonly TestingPlanIssue[]): ExplainedTask {
  return {
    ...taskHeadFields(task, task.project),
    reasonText: reasonTexts[task.reason] ?? task.reason,
    causes: (task.causes ?? []).map((cause) => explainCause(cause, issues)),
  };
}

function explainCause(cause: TestingTaskCause, issues: readonly TestingPlanIssue[]): ExplanationCause {
  if (cause.kind === "reached-import") {
    const location = cause.line === undefined ? undefined : formatSourceLocation(cause.path, cause.line, cause.column);
    return {
      kind: "reached-import",
      path: cause.path,
      ...(location === undefined ? {} : { location }),
      importedFrom: cause.importedFrom,
      symbols: cause.symbols,
    };
  }
  if (cause.kind === "issue") {
    return { kind: "issue", issue: explainIssueAt(issues, cause.index) };
  }
  return cause;
}

function engineFullFallbackCauses(plan: TestingPlanResult): readonly ExplainedIssue[] {
  const indexes = new Set<number>();
  for (const task of plan.tasks) {
    if (task.reason !== "full-fallback") continue;
    for (const cause of task.causes ?? []) {
      if (cause.kind === "issue") indexes.add(cause.index);
    }
  }
  return [...indexes].sort((left, right) => left - right).map((index) => explainIssueAt(plan.issues, index));
}

// --- Derived causes ------------------------------------------------------

function explainWithDerivedCauses(
  task: TestingTaskDecision,
  plan: TestingPlanResult,
  manifest: TestingManifest | undefined,
): ExplainedTask {
  const project = task.project ?? manifest?.tasks.find((candidate) => candidate.id === task.id)?.project;
  const reasonText = reasonTexts[task.reason] ?? task.reason;
  return {
    ...taskHeadFields(task, project),
    reasonText: task.reason === "graph-symbol-importer" ? `${reasonText}${derivedSymbolNote}` : reasonText,
    causes: deriveCauses(task, plan, manifest, project),
  };
}

function deriveCauses(
  task: TestingTaskDecision,
  plan: TestingPlanResult,
  manifest: TestingManifest | undefined,
  project: string | undefined,
): readonly ExplanationCause[] {
  switch (task.reason) {
    case "direct-task-input":
      return [{ kind: "direct-task-input", taskId: task.id }];
    case "full-fallback":
      return workspaceUncertaintyIssues(plan.issues).map(asIssueCause);
    case "graph-uncertainty-project-fallback":
      return [
        ...moduleUncertaintyIssues(plan.issues, project).map(asIssueCause),
        ...ownedChangedPathCauses(plan, manifest, project),
      ];
    case "changed-owned-project":
    case "graph-changed-export":
      return ownedChangedPathCauses(plan, manifest, project);
    case "selected-prerequisite":
      return prerequisiteCauses(task.id, plan, manifest);
    // impact-always, proven-unaffected, graph-symbol-importer and any reason
    // this build does not know carry no evidence that can be reconstructed.
    default:
      return [];
  }
}

function derivedFullFallbackCauses(plan: TestingPlanResult): readonly ExplainedIssue[] {
  if (!plan.tasks.some((task) => task.reason === "full-fallback")) return [];
  return workspaceUncertaintyIssues(plan.issues);
}

function ownedChangedPathCauses(
  plan: TestingPlanResult,
  manifest: TestingManifest | undefined,
  project: string | undefined,
): readonly ExplanationCause[] {
  if (manifest === undefined || project === undefined) return [];
  return plan.scope.changedPaths
    .filter((path) => owningProjectForPath(manifest.projects, path)?.id === project)
    .map((path): ExplanationCause => ({ kind: "changed-path", path }));
}

function prerequisiteCauses(
  taskId: string,
  plan: TestingPlanResult,
  manifest: TestingManifest | undefined,
): readonly ExplanationCause[] {
  if (manifest === undefined) return [];
  const selected = new Set(plan.tasks.filter((task) => task.decision === "run").map((task) => task.id));
  return manifest.tasks
    .filter((task) => selected.has(task.id) && task.dependsOn.includes(taskId))
    .map((task): ExplanationCause => ({
      kind: "prerequisite-of",
      taskId: task.id,
    }));
}

function workspaceUncertaintyIssues(issues: readonly TestingPlanIssue[]): readonly ExplainedIssue[] {
  return issues
    .filter((issue) => issueScope(issue) === "workspace" && issueSeverity(issue) !== "info")
    .map(explainIssue);
}

/**
 * A module-scope uncertainty explains a project only when it names that project
 * or names none: an uncertainty about another module is not evidence here.
 */
function moduleUncertaintyIssues(
  issues: readonly TestingPlanIssue[],
  project: string | undefined,
): readonly ExplainedIssue[] {
  return issues
    .filter(
      (issue) =>
        issueScope(issue) === "module" &&
        issueSeverity(issue) !== "info" &&
        (issue.project === undefined || issue.project === project),
    )
    .map(explainIssue);
}

function asIssueCause(issue: ExplainedIssue): ExplanationCause {
  return { kind: "issue", issue };
}

// --- Shared shaping ------------------------------------------------------

function taskHeadFields(
  task: TestingTaskDecision,
  project: string | undefined,
): Omit<ExplainedTask, "reasonText" | "causes"> {
  const files = task.selectedFiles;
  return {
    id: task.id,
    ...(project === undefined ? {} : { project }),
    decision: task.decision,
    reason: task.reason,
    confidence: task.confidence,
    widened: task.widened,
    ...(files === undefined || files.length === 0 ? {} : { selectedFiles: files }),
  };
}

function countByReason(tasks: readonly TestingTaskDecision[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    counts[task.reason] = (counts[task.reason] ?? 0) + 1;
  }
  return counts;
}

function explainIssue(issue: TestingPlanIssue): ExplainedIssue {
  const location = formatIssueLocation(issue);
  return {
    code: issue.code,
    message: issue.message,
    ...(location === undefined ? {} : { location }),
    severity: issueSeverity(issue),
    scope: issueScope(issue),
    ...(issue.project === undefined ? {} : { project: issue.project }),
  };
}

/**
 * Resolves an issue reference. A reference the plan cannot satisfy is reported
 * as its own uncertainty rather than dropped: a cause that cannot be shown is
 * still a cause, and losing it would make the explanation look complete.
 */
function explainIssueAt(issues: readonly TestingPlanIssue[], index: number): ExplainedIssue {
  const issue = issues[index];
  if (issue === undefined) {
    return {
      code: "unknown-issue-index",
      message: `the plan referenced issue index ${String(index)}, which it does not contain`,
      severity: "uncertainty",
      scope: "unknown",
    };
  }
  return explainIssue(issue);
}

/** Formats a source position exactly as an issue location is formatted. */
function formatSourceLocation(path: string, line: number | undefined, column: number | undefined): string {
  return (
    formatIssueLocation({
      code: "source-location",
      message: "",
      path,
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
    }) ?? path
  );
}

// --- Human rendering -----------------------------------------------------

function renderScope(scope: TestingPlanResult["scope"]): string {
  const tokens = [`kind=${scope.kind}`];
  if (scope.base !== undefined) tokens.push(`base=${scope.base}`);
  if (scope.head !== undefined) tokens.push(`head=${scope.head}`);
  tokens.push(`changed=${String(scope.changedPaths.length)}`);
  return `scope: ${tokens.join(" ")}`;
}

function renderTaskHeadline(task: ExplainedTask): string {
  const tokens = [task.decision === "run" ? "RUN" : "SKIP", task.id];
  if (task.project !== undefined) tokens.push(`project=${task.project}`);
  tokens.push(`reason=${task.reason}`, `confidence=${task.confidence}`, `widened=${task.widened ? "yes" : "no"}`);
  return tokens.join(" ");
}

function renderCause(cause: ExplanationCause): string {
  if (cause.kind === "changed-path") return `changed ${cause.path}`;
  if (cause.kind === "changed-export") return `export ${cause.symbol} ${cause.path}`;
  if (cause.kind === "reached-import") {
    const symbols = cause.symbols.length === 0 ? "" : ` ${cause.symbols.join(",")}`;
    return `import ${cause.location ?? cause.path} from ${cause.importedFrom}${symbols}`;
  }
  return renderSecondaryCause(cause);
}

function renderSecondaryCause(
  cause: Exclude<ExplanationCause, { kind: "changed-path" | "changed-export" | "reached-import" }>,
): string {
  switch (cause.kind) {
    case "prerequisite-of":
      return `prerequisite-of ${cause.taskId}`;
    case "direct-task-input":
      return `direct-task-input ${cause.taskId}`;
    case "issue":
      return `issue ${renderIssue(cause.issue)}`;
    case "fallback-dependency":
      return `fallback-dependency ${cause.project}`;
    case "sql-object":
      return `sql-object ${cause.object}`;
  }
}

function renderIssue(issue: ExplainedIssue): string {
  const location = issue.location === undefined ? "" : `${issue.location} `;
  return `${issue.code} ${location}${issue.message}`;
}
