import type { OptionSpecification } from "../cli-arguments.js";
import { writeCommandSuccess } from "../cli-output.js";
import type { DadTestCliIo, DadTestCommand } from "../dad-test-cli.js";
import { doctorTesting } from "../testing-api.js";
import type { TestingDoctorFinding, TestingDoctorResult } from "../testing-api.js";

const doctorOptions: readonly OptionSpecification[] = [
  { name: "--manifest", kind: "value" },
  { name: "--max-workspace-uncertainties", kind: "value" },
];

/**
 * `dad-test doctor` verifies workspace setup invariants statically without
 * running test suites: Vitest tier target parity, runner ↔ fileNarrowing
 * agreement, complete test-file ownership, non-overlapping narrowed targets,
 * and zero whole-workspace graph uncertainties.
 */
export const doctorCommand: DadTestCommand = {
  options: doctorOptions,
  execute: async (parsed, io, json) => {
    const manifestPath = parsed.values.get("--manifest");
    const maxWorkspace = parseOptionalNonNegativeInt(
      parsed.values.get("--max-workspace-uncertainties"),
      "--max-workspace-uncertainties",
    );
    const raw = await doctorTesting({
      workspaceRoot: io.cwd,
      ...(manifestPath === undefined ? {} : { manifestPath }),
      ...(io.nativeBinary === undefined ? {} : { nativeBinary: io.nativeBinary }),
    });
    const result = applyDoctorThreshold(raw, maxWorkspace ?? 0);
    if (json) {
      writeCommandSuccess(io, true, "doctor", result);
    } else {
      io.stdout(renderDoctorResult(result));
    }
    return result.ok ? 0 : 1;
  },
};

function parseOptionalNonNegativeInt(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/u.test(raw.trim())) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return value;
}

function applyDoctorThreshold(result: TestingDoctorResult, maxWorkspaceUncertainties: number): TestingDoctorResult {
  if (maxWorkspaceUncertainties === 0) return result;
  const withinBudget = result.counts.workspaceUncertainties <= maxWorkspaceUncertainties;
  const findings = withinBudget
    ? result.findings.filter((item) => item.code !== "workspace-uncertainty")
    : result.findings;
  const errors = findings.filter((item) => item.severity === "error").length;
  const warnings = findings.length - errors;
  return {
    ...result,
    ok: errors === 0,
    counts: {
      ...result.counts,
      errors,
      warnings,
    },
    findings,
  };
}

/** Renders a human-readable summary of `dad-test doctor` findings. */
export function renderDoctorResult(result: TestingDoctorResult): string {
  const { counts, findings } = result;
  if (result.ok && findings.length === 0) {
    return `doctor: ok (${String(counts.projectsChecked)} projects, ${String(counts.testTasksChecked)} test tasks, ${String(counts.testFilesChecked)} test files, 0 findings).\n`;
  }
  const lines: string[] = [
    `doctor: ${result.ok ? "ok" : "FAILED"} (${String(counts.errors)} error(s), ${String(counts.warnings)} warning(s) across ${String(counts.projectsChecked)} projects, ${String(counts.testTasksChecked)} test tasks, ${String(counts.testFilesChecked)} test files):`,
  ];
  for (const finding of findings) {
    lines.push(formatFinding(finding));
    lines.push(`    fix: ${finding.fix}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatFinding(finding: TestingDoctorFinding): string {
  const scope = finding.taskId ?? finding.project ?? "workspace";
  const location = finding.path ? ` (${finding.path})` : "";
  return `  [${finding.code}] ${scope}${location}: ${finding.message}`;
}
