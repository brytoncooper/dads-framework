import type { ExplainedIssue, ExplainedTask, ExplanationCause, PlanExplanation } from "../explain-plan.js";
import type { TestingManifest } from "../testing-manifest.js";

/**
 * Focused per-task causal chain builder for `dad-test explain --why <taskId>`.
 * Distills a full `PlanExplanation` down to a single task's decision, causal
 * chain (`changed ... -> cause -> task`), widened task count, and 1-line fix.
 */

export type FocusedTaskExplanation = {
  readonly schemaVersion: 1;
  readonly task: ExplainedTask;
  readonly chain: readonly string[];
  readonly widenedTasksCount: number;
  readonly suggestedFix: string;
};

/** Builds a focused causal explanation for one task in an already-computed plan. */
export function buildFocusedTaskExplanation(
  explanation: PlanExplanation,
  taskId: string,
  manifest?: TestingManifest,
): FocusedTaskExplanation {
  const task = explanation.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) {
    throw new Error(`Unknown task '${taskId}' in plan. Available tasks: ${formatAvailableTasks(explanation.tasks)}.`);
  }
  const widenedTasksCount = explanation.summary.widened;
  return {
    schemaVersion: 1,
    task,
    chain: buildCausalChain(task, explanation, widenedTasksCount),
    widenedTasksCount,
    suggestedFix: buildSuggestedFix(task, explanation, manifest),
  };
}

/** Renders the 3-line causal summary + 1-line actionable fix. */
export function renderFocusedTaskExplanation(focused: FocusedTaskExplanation): string {
  const { task, chain, suggestedFix } = focused;
  const verdict = task.decision === "run" ? "RUN" : "SKIP";
  const widened = task.widened ? "yes" : "no";
  return [
    `why ${task.id}: ${verdict} (${task.reason}, widened=${widened})`,
    `  chain: ${chain.join(" -> ")}`,
    `  fix: ${suggestedFix}`,
    "",
  ].join("\n");
}

function buildCausalChain(task: ExplainedTask, explanation: PlanExplanation, widenedCount: number): readonly string[] {
  if (task.decision === "skip-proven-unaffected") {
    return buildSkippedChain(task, explanation);
  }
  const targetHop = formatTargetHop(task, widenedCount);
  const issue = findPrimaryIssue(task, explanation);
  if (task.reason === "full-fallback") {
    return buildFullFallbackChain(explanation, issue, targetHop);
  }
  if (task.reason === "graph-uncertainty-project-fallback") {
    return buildUncertaintyChain(task, explanation, issue, targetHop);
  }
  if (task.reason === "graph-symbol-importer") {
    return buildSymbolImporterChain(task, explanation, targetHop);
  }
  return buildDirectOrSecondaryChain(task, explanation, issue, targetHop);
}

function buildSkippedChain(task: ExplainedTask, explanation: PlanExplanation): readonly string[] {
  const changed = formatChangedOrigin(explanation.scope.changedPaths);
  if (changed === undefined) {
    return ["no changed files", `${task.id} (unaffected)`];
  }
  return [changed, "no reaching path or symbol", `${task.id} (unaffected)`];
}

function buildFullFallbackChain(
  explanation: PlanExplanation,
  issue: ExplainedIssue | undefined,
  targetHop: string,
): readonly string[] {
  if (explanation.scope.kind === "all" && issue === undefined) {
    return ["--all requested", targetHop];
  }
  const origin = formatOriginFromIssueOrScope(issue, explanation.scope.changedPaths);
  const cause = issue === undefined ? "full-fallback" : `issue ${issue.code}`;
  return [origin, cause, targetHop];
}

function buildUncertaintyChain(
  task: ExplainedTask,
  explanation: PlanExplanation,
  issue: ExplainedIssue | undefined,
  targetHop: string,
): readonly string[] {
  const origin = formatOriginFromCausesOrIssue(task.causes, issue, explanation.scope.changedPaths);
  const fallback = findFallbackCause(task.causes);
  const baseCause = issue === undefined ? task.reason : `issue ${issue.code}`;
  const cause = fallback === undefined ? baseCause : `${baseCause} via fallback-dependency ${fallback.project}`;
  return [origin, cause, targetHop];
}

function buildSymbolImporterChain(
  task: ExplainedTask,
  explanation: PlanExplanation,
  targetHop: string,
): readonly string[] {
  const reached = findReachedImportCause(task.causes);
  if (reached === undefined) {
    const origin = formatChangedOrigin(explanation.scope.changedPaths) ?? "changed dependency";
    return [origin, "imports changed symbol", targetHop];
  }
  const symbols = reached.symbols.length === 0 ? "" : ` (${reached.symbols.join(", ")})`;
  const importer = reached.location ?? reached.path;
  return [`changed ${reached.importedFrom}`, `imported by ${importer}${symbols}`, targetHop];
}

function buildDirectOrSecondaryChain(
  task: ExplainedTask,
  explanation: PlanExplanation,
  issue: ExplainedIssue | undefined,
  targetHop: string,
): readonly string[] {
  if (task.reason === "selected-prerequisite") {
    const prereq = findPrerequisiteCause(task.causes);
    const dependent = prereq === undefined ? "selected dependent" : `prerequisite of ${prereq.taskId}`;
    return [dependent, targetHop];
  }
  if (task.reason === "impact-always") return ["impact.mode=always", targetHop];
  if (task.reason === "direct-task-input") return ["--task input", targetHop];
  if (task.reason.startsWith("sql-")) return buildSqlChain(task, explanation, issue, targetHop);
  return buildChangedPathChain(task, explanation, targetHop);
}

function buildSqlChain(
  task: ExplainedTask,
  explanation: PlanExplanation,
  issue: ExplainedIssue | undefined,
  targetHop: string,
): readonly string[] {
  const origin = formatChangedOrigin(explanation.scope.changedPaths) ?? "changed SQL migration";
  const sqlCause = findSqlCause(task.causes);
  const middle =
    sqlCause !== undefined
      ? `sql-object ${sqlCause.object}`
      : issue !== undefined
        ? `issue ${issue.code}`
        : task.reason;
  return [origin, middle, targetHop];
}

function buildChangedPathChain(
  task: ExplainedTask,
  explanation: PlanExplanation,
  targetHop: string,
): readonly string[] {
  const changedExport = findChangedExportCause(task.causes);
  if (changedExport !== undefined) {
    return [`changed ${changedExport.path}`, `export ${changedExport.symbol}`, targetHop];
  }
  const changedPath = findChangedPathCause(task.causes);
  const origin =
    changedPath !== undefined
      ? `changed ${changedPath.path}`
      : (formatChangedOrigin(explanation.scope.changedPaths) ?? task.reason);
  const fallback = findFallbackCause(task.causes);
  const middle =
    fallback !== undefined
      ? `fallback-dependency ${fallback.project}`
      : task.reason === "changed-file-input"
        ? "declared impact.paths"
        : `owned by ${task.project ?? "project"}`;
  return [origin, middle, targetHop];
}

function buildSuggestedFix(
  task: ExplainedTask,
  explanation: PlanExplanation,
  manifest: TestingManifest | undefined,
): string {
  if (task.decision === "skip-proven-unaffected") return "none (skipped — proven unaffected)";
  if (!task.widened) return "none (proven affected)";
  if (explanation.scope.kind === "all" && task.reason === "full-fallback") {
    return "none (--all requested full workspace run)";
  }
  const issue = findPrimaryIssue(task, explanation);
  if (issue !== undefined) {
    const issueFix = suggestFixForIssue(issue, manifest);
    if (issueFix !== undefined) return issueFix;
  }
  return suggestFixForReason(task, explanation);
}

function suggestFixForIssue(issue: ExplainedIssue, manifest: TestingManifest | undefined): string | undefined {
  if (issue.code === "nonliteral-dynamic-import" || issue.code === "nonliteral-commonjs-require") {
    const filePath = stripLineColumn(issue.location) ?? "<loader-file>";
    const projectRoot = resolveProjectRootForIssue(issue, manifest) ?? "<project-root>";
    return `add "${filePath}": ["${projectRoot}"] to workspace.dynamicImportScopes in dads.testing.json (or run npx dad-test diagnose --fix)`;
  }
  if (issue.code === "unknown-changed-path") {
    return suggestUnownedPathFix(stripLineColumn(issue.location));
  }
  if (/impure|side-effect|pure/iu.test(issue.code) || /impure|pureFactories/iu.test(issue.message)) {
    return "add the pure factory call to workspace.pureFactories in dads.testing.json (or run npx dad-test diagnose --fix)";
  }
  return suggestCodeRefactorFix(issue);
}

function suggestCodeRefactorFix(issue: ExplainedIssue): string | undefined {
  if (
    issue.code === "unresolved-bare-module" ||
    issue.code === "unresolved-local-module" ||
    issue.code === "unresolved-module-scheme"
  ) {
    return `use 'import type' or fix tsconfig paths / package.json exports for ${issue.location ?? "the unresolved import"}`;
  }
  if (issue.code.startsWith("ambiguous-")) {
    return `replace ambiguous default/star export at ${issue.location ?? "the reported file"} with explicit named exports`;
  }
  return undefined;
}

function suggestFixForReason(task: ExplainedTask, explanation: PlanExplanation): string {
  if (task.reason === "sql-unmapped-project") {
    return `declare sqlImpact.tables on task "${task.id}" in dads.testing.json for table-level narrowing`;
  }
  if (task.reason === "sql-global-ddl-fallback") {
    return "keep widened for global DDL or isolate schema-wide DDL into a dedicated migration";
  }
  if (task.reason === "full-fallback") {
    return suggestUnownedPathFix(explanation.scope.changedPaths[0]);
  }
  return `run npx dad-test diagnose --fix to inspect and narrow ${task.reason}`;
}

function suggestUnownedPathFix(path: string | undefined): string {
  const safeIgnore = safeIgnoreHintForPath(path);
  if (safeIgnore !== undefined) {
    return `add "${safeIgnore}" to workspace.ignorePaths in dads.testing.json (or run npx dad-test diagnose --fix)`;
  }
  const subject = path ?? "<path>";
  return `declare a project owning "${subject}" or add it to workspace.ignorePaths in dads.testing.json if no test reads it`;
}

const safeHintDirectories: readonly string[] = ["docs", ".github", ".vscode"];

function safeIgnoreHintForPath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  for (const dir of safeHintDirectories) {
    if (path === dir || path.startsWith(`${dir}/`)) return `${dir}/**`;
  }
  if (path === "README.md") return "README.md";
  if (/^LICENSE(\.[^/]+)?$/iu.test(path)) return "LICENSE*";
  if (/^CHANGELOG(\.[^/]+)?$/iu.test(path)) return "CHANGELOG*";
  return path.toLowerCase().endsWith(".md") ? "**/*.md" : undefined;
}

function resolveProjectRootForIssue(issue: ExplainedIssue, manifest: TestingManifest | undefined): string | undefined {
  if (issue.project === undefined || manifest === undefined) return undefined;
  return manifest.projects.find((project) => project.id === issue.project)?.root;
}

function findPrimaryIssue(task: ExplainedTask, explanation: PlanExplanation): ExplainedIssue | undefined {
  for (const cause of task.causes) {
    if (cause.kind === "issue") return cause.issue;
  }
  return task.reason === "full-fallback" ? explanation.summary.fullFallbackCauses[0] : undefined;
}

function findFallbackCause(
  causes: readonly ExplanationCause[],
): Extract<ExplanationCause, { readonly kind: "fallback-dependency" }> | undefined {
  for (const cause of causes) {
    if (cause.kind === "fallback-dependency") return cause;
  }
  return undefined;
}

function findReachedImportCause(
  causes: readonly ExplanationCause[],
): Extract<ExplanationCause, { readonly kind: "reached-import" }> | undefined {
  for (const cause of causes) {
    if (cause.kind === "reached-import") return cause;
  }
  return undefined;
}

function findPrerequisiteCause(
  causes: readonly ExplanationCause[],
): Extract<ExplanationCause, { readonly kind: "prerequisite-of" }> | undefined {
  for (const cause of causes) {
    if (cause.kind === "prerequisite-of") return cause;
  }
  return undefined;
}

function findSqlCause(
  causes: readonly ExplanationCause[],
): Extract<ExplanationCause, { readonly kind: "sql-object" }> | undefined {
  for (const cause of causes) {
    if (cause.kind === "sql-object") return cause;
  }
  return undefined;
}

function findChangedExportCause(
  causes: readonly ExplanationCause[],
): Extract<ExplanationCause, { readonly kind: "changed-export" }> | undefined {
  for (const cause of causes) {
    if (cause.kind === "changed-export") return cause;
  }
  return undefined;
}

function findChangedPathCause(
  causes: readonly ExplanationCause[],
): Extract<ExplanationCause, { readonly kind: "changed-path" }> | undefined {
  for (const cause of causes) {
    if (cause.kind === "changed-path") return cause;
  }
  return undefined;
}

function formatOriginFromCausesOrIssue(
  causes: readonly ExplanationCause[],
  issue: ExplainedIssue | undefined,
  changedPaths: readonly string[],
): string {
  if (issue?.location !== undefined) return `changed ${issue.location}`;
  const changed = findChangedPathCause(causes);
  if (changed !== undefined) return `changed ${changed.path}`;
  return formatChangedOrigin(changedPaths) ?? "workspace change";
}

function formatOriginFromIssueOrScope(issue: ExplainedIssue | undefined, changedPaths: readonly string[]): string {
  if (issue?.location !== undefined) return `changed ${issue.location}`;
  return formatChangedOrigin(changedPaths) ?? "workspace change";
}

function formatChangedOrigin(changedPaths: readonly string[]): string | undefined {
  const first = changedPaths[0];
  if (first === undefined) return undefined;
  const extra = changedPaths.length - 1;
  return extra > 0 ? `changed ${first} (+${String(extra)} more)` : `changed ${first}`;
}

function formatTargetHop(task: ExplainedTask, widenedCount: number): string {
  if (!task.widened || widenedCount === 0) return task.id;
  const noun = widenedCount === 1 ? "task" : "tasks";
  return `${task.id} (widened ${String(widenedCount)} ${noun})`;
}

function stripLineColumn(location: string | undefined): string | undefined {
  if (location === undefined) return undefined;
  return location.replace(/:\d+(?::\d+)?$/u, "");
}

function formatAvailableTasks(tasks: readonly ExplainedTask[]): string {
  if (tasks.length === 0) return "none";
  const limit = 10;
  const names = tasks.slice(0, limit).map((task) => task.id);
  return tasks.length > limit ? `${names.join(", ")}, ... (${String(tasks.length)} total)` : names.join(", ");
}
