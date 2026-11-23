import type { VerificationGraphReport } from "./verification-contract.js";

export function formatVerificationReport(report: VerificationGraphReport): string {
  if (report.results.length === 0) {
    return report.ok
      ? "Verification not-applicable: no tasks were selected."
      : `Verification failed: ${report.issues.join(" ")}`;
  }
  const lines = report.results.map(
    (result) => `${result.taskId.padEnd(28)} ${result.status.padEnd(14)} ${result.reason}`,
  );
  const summary = [
    `executed=${String(report.counts.executed)}`,
    `reused=${String(report.counts.reused)}`,
    `failed=${String(report.counts.failed)}`,
    `blocked=${String(report.counts.blocked)}`,
    `not-applicable=${String(report.counts["not-applicable"])}`,
  ].join(" ");
  return [...lines, summary].join("\n");
}
