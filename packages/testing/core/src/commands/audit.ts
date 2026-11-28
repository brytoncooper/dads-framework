import type { OptionSpecification, ParsedArguments } from "../cli-arguments.js";
import { readPositiveInteger } from "../cli-arguments.js";
import { writeCommandSuccess } from "../cli-output.js";
import type { DadTestCliIo, DadTestCommand } from "../dad-test-cli.js";
import { runTesting } from "../testing-api.js";
import type {
  TestingOperationRequest,
  TestingPlanResult,
  TestingRunResult,
  TestingUndeclaredRead,
} from "../testing-api.js";
import { defaultTestingManifestFileName } from "../testing-manifest.js";
import { applyAuditManifestFixes, collapseAuditImpactPaths, type AuditPathProposal } from "./audit-fix.js";

export type TestingAuditTaskFinding = {
  readonly taskId: string;
  readonly project?: string;
  readonly undeclaredReads: readonly TestingUndeclaredRead[];
  readonly suggestedImpactPaths: readonly string[];
};

export type TestingAuditResult = {
  readonly schemaVersion: 1;
  readonly mode: "report" | "fix" | "dry-run";
  readonly auditedTasks: number;
  readonly tasksWithUndeclaredReads: number;
  readonly totalUndeclaredReads: number;
  readonly findings: readonly TestingAuditTaskFinding[];
  readonly fixed: boolean;
  readonly manifestPath: string;
  readonly changes: Readonly<Record<string, readonly string[]>>;
  readonly runExitCode: number;
};

const auditOptions: readonly OptionSpecification[] = [
  { name: "--fix", kind: "flag" },
  { name: "--dry-run", kind: "flag" },
  { name: "--no-per-file", kind: "flag" },
  { name: "--fail-on-findings", kind: "flag" },
  { name: "--target", kind: "repeatable" },
  { name: "--project", kind: "repeatable" },
  { name: "--task", kind: "repeatable" },
  { name: "--jobs", kind: "value" },
  { name: "--manifest", kind: "value" },
];

/**
 * `dad-test audit` executes test tasks with the runtime file-read tracer in
 * non-failing audit mode, aggregates undeclared workspace reads per task, and
 * with `--fix` patches `dads.testing.json` after validating via `dad-test plan`.
 */
export const auditCommand: DadTestCommand = {
  options: auditOptions,
  execute: async (parsed, io, json) => {
    const request = buildAuditRunRequest(parsed, io);
    const { plan, run } = await runTesting(request);
    const findings = collectAuditFindings(plan, run);
    const fixRequested = parsed.flags.has("--fix");
    const dryRun = parsed.flags.has("--dry-run");
    const manifestPath = parsed.values.get("--manifest") ?? defaultTestingManifestFileName;
    const fixOutcome = await runAuditFixIfRequested(
      fixRequested,
      dryRun,
      io,
      parsed.values.get("--manifest"),
      findings,
    );
    const result = buildAuditResult({
      findings,
      run,
      fixRequested,
      dryRun,
      manifestPath: fixOutcome?.manifestPath ?? manifestPath,
      fixed: fixOutcome?.applied ?? false,
      changes: fixOutcome?.changes ?? {},
    });
    if (json) {
      writeCommandSuccess(io, true, "audit", result);
    } else {
      io.stdout(renderAuditResult(result));
    }
    return resolveAuditExitCode(run.exitCode, parsed.flags.has("--fail-on-findings"), findings.length);
  },
};

function resolveAuditExitCode(runExitCode: number, failOnFindings: boolean, findingCount: number): number {
  if (failOnFindings && findingCount > 0 && runExitCode === 0) {
    return 1;
  }
  return runExitCode;
}

function readAuditList(parsed: ParsedArguments, flag: string): readonly string[] | undefined {
  const values = collectAuditCommaList(parsed.repeated.get(flag) ?? []);
  return values.length > 0 ? values : undefined;
}

function buildAuditScopeFilter(parsed: ParsedArguments): {
  readonly all?: boolean;
  readonly only?: boolean;
  readonly taskKinds?: readonly string[];
  readonly targets?: readonly string[];
  readonly projects?: readonly string[];
  readonly taskIds?: readonly string[];
} {
  const projects = readAuditList(parsed, "--project");
  const taskIds = readAuditList(parsed, "--task");
  const targets = readAuditList(parsed, "--target");
  const hasScope = Boolean(projects || taskIds || targets);
  return {
    ...(hasScope ? { only: true } : { all: true }),
    ...(taskIds ? { taskIds } : { taskKinds: ["test"] }),
    ...(targets ? { targets } : {}),
    ...(projects ? { projects } : {}),
  };
}

function buildAuditRunRequest(parsed: ParsedArguments, io: DadTestCliIo): TestingOperationRequest {
  const manifestPath = parsed.values.get("--manifest");
  const jobs = parsed.values.get("--jobs");
  return {
    workspaceRoot: io.cwd,
    auditReads: true,
    auditPerFile: !parsed.flags.has("--no-per-file"),
    cache: false,
    ...buildAuditScopeFilter(parsed),
    ...(manifestPath === undefined ? {} : { manifestPath }),
    ...(jobs === undefined ? {} : { jobs: readPositiveInteger(jobs, "--jobs") }),
    ...(io.nativeBinary === undefined ? {} : { nativeBinary: io.nativeBinary }),
  };
}

function collectAuditCommaList(values: readonly string[]): readonly string[] {
  const unique: string[] = [];
  for (const raw of values) {
    for (const part of raw.split(",")) {
      const trimmed = part.trim();
      if (trimmed.length > 0 && !unique.includes(trimmed)) {
        unique.push(trimmed);
      }
    }
  }
  return unique;
}

function collectAuditFindings(plan: TestingPlanResult, run: TestingRunResult): readonly TestingAuditTaskFinding[] {
  const projectByTask = new Map<string, string>();
  for (const decision of plan.tasks) {
    if (decision.project !== undefined) {
      projectByTask.set(decision.id, decision.project);
    }
  }
  const findings: TestingAuditTaskFinding[] = [];
  for (const task of run.tasks) {
    const reads = task.undeclaredReads;
    if (reads === undefined || reads.length === 0) continue;
    const project = projectByTask.get(task.id);
    const suggestedImpactPaths = collapseAuditImpactPaths(reads.map((item) => item.path));
    findings.push({
      taskId: task.id,
      ...(project === undefined ? {} : { project }),
      undeclaredReads: reads,
      suggestedImpactPaths,
    });
  }
  return findings;
}

async function runAuditFixIfRequested(
  fixRequested: boolean,
  dryRun: boolean,
  io: DadTestCliIo,
  manifestPath: string | undefined,
  findings: readonly TestingAuditTaskFinding[],
): Promise<
  | {
      readonly manifestPath: string;
      readonly applied: boolean;
      readonly changes: Readonly<Record<string, readonly string[]>>;
    }
  | undefined
> {
  if (!fixRequested && !dryRun) return undefined;
  const proposals: readonly AuditPathProposal[] = findings.map((finding) => ({
    taskId: finding.taskId,
    ...(finding.project === undefined ? {} : { project: finding.project }),
    suggestedPaths: finding.suggestedImpactPaths,
  }));
  return applyAuditManifestFixes({
    workspaceRoot: io.cwd,
    ...(manifestPath === undefined ? {} : { manifestPath }),
    proposals,
    dryRun: dryRun || !fixRequested,
    ...(io.nativeBinary === undefined ? {} : { nativeBinary: io.nativeBinary }),
  });
}

function buildAuditResult(input: {
  readonly findings: readonly TestingAuditTaskFinding[];
  readonly run: TestingRunResult;
  readonly fixRequested: boolean;
  readonly dryRun: boolean;
  readonly manifestPath: string;
  readonly fixed: boolean;
  readonly changes: Readonly<Record<string, readonly string[]>>;
}): TestingAuditResult {
  let totalUndeclaredReads = 0;
  for (const finding of input.findings) {
    totalUndeclaredReads += finding.undeclaredReads.length;
  }
  const mode: TestingAuditResult["mode"] = input.dryRun ? "dry-run" : input.fixRequested ? "fix" : "report";
  return {
    schemaVersion: 1,
    mode,
    auditedTasks: input.run.counts.executed,
    tasksWithUndeclaredReads: input.findings.length,
    totalUndeclaredReads,
    findings: input.findings,
    fixed: input.fixed,
    manifestPath: input.manifestPath,
    changes: input.changes,
    runExitCode: input.run.exitCode,
  };
}

/** Renders a human-readable summary of undeclared workspace file reads per task. */
export function renderAuditResult(result: TestingAuditResult): string {
  if (result.findings.length === 0) {
    return `audit: clean (${String(result.auditedTasks)} task(s) audited, 0 undeclared workspace reads).\n`;
  }
  const lines: string[] = [
    `audit: ${String(result.totalUndeclaredReads)} undeclared workspace read(s) across ${String(result.tasksWithUndeclaredReads)} task(s) (${String(result.auditedTasks)} audited):`,
  ];
  for (const finding of result.findings) {
    lines.push(`  ${finding.taskId}:`);
    appendFindingLines(lines, finding);
  }
  appendAuditFooter(lines, result);
  return `${lines.join("\n")}\n`;
}

function appendFindingLines(lines: string[], finding: TestingAuditTaskFinding): void {
  for (const read of finding.undeclaredReads) {
    const loc = read.location === undefined ? "" : `  (read at ${read.location})`;
    const via = read.selectedFile === undefined ? "" : `  [when narrowed to ${read.selectedFile}]`;
    lines.push(`    - ${read.path}${loc}${via}`);
  }
  const quoted = finding.suggestedImpactPaths.map((entry) => `"${entry}"`).join(", ");
  lines.push(`    suggested impact.paths: ${quoted}`);
}

function appendAuditFooter(lines: string[], result: TestingAuditResult): void {
  if (result.fixed) {
    lines.push(`Updated ${result.manifestPath} (validated with dad-test plan).`);
    return;
  }
  if (result.mode === "dry-run") {
    lines.push(`Dry run: would update ${result.manifestPath} (re-run with --fix without --dry-run to apply).`);
    return;
  }
  lines.push(`Fix: run \`npx dad-test audit --fix\` to update ${result.manifestPath}.`);
}
