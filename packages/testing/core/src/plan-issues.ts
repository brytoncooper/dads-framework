import type { TestingPlanIssue } from "./testing-api.js";

/**
 * Plan issues are read from an engine that may be older than this facade. Every
 * classifying field is optional on the wire, so these helpers derive the same
 * answer from the issue code when a field is missing.
 */

/** Returns the declared severity, or the severity implied by the issue code. */
export function issueSeverity(issue: TestingPlanIssue): "info" | "uncertainty" | "error" {
  if (issue.severity !== undefined) return issue.severity;
  return issue.code.startsWith("graph-") || issue.code.startsWith("snapshot-") ? "info" : "uncertainty";
}

/**
 * Returns the declared scope, or the scope implied by the issue code. An
 * informational issue with no declared scope is "unknown" rather than "module":
 * it is not evidence that any one module is uncertain.
 */
export function issueScope(issue: TestingPlanIssue): "module" | "workspace" | "unknown" {
  if (issue.scope !== undefined) return issue.scope;
  if (issue.code === "unknown-changed-path" || issue.code === "reachable-module-unowned") {
    return "workspace";
  }
  return issueSeverity(issue) === "info" ? "unknown" : "module";
}

/** Formats the issue location as path:line:column, degrading as fields are missing. */
export function formatIssueLocation(issue: TestingPlanIssue): string | undefined {
  if (issue.path === undefined) return undefined;
  if (issue.line === undefined) return issue.path;
  if (issue.column === undefined) {
    return `${issue.path}:${String(issue.line)}`;
  }
  return `${issue.path}:${String(issue.line)}:${String(issue.column)}`;
}
