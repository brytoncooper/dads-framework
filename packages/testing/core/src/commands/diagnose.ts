import type { OptionSpecification } from "../cli-arguments.js";
import { writeCommandSuccess } from "../cli-output.js";
import type { DadTestCommand } from "../dad-test-cli.js";
import { diagnoseTesting } from "../testing-api.js";
import type {
  TestingCouplingHotspot,
  TestingDiagnoseResult,
  TestingFallbackTrap,
  TestingWideningCulprit,
} from "../testing-api.js";

const diagnoseOptions: readonly OptionSpecification[] = [{ name: "--manifest", kind: "value" }];

/**
 * `dad-test diagnose` inspects the workspace's dependency graph and manifest
 * without requiring a Git diff, reporting widening culprits, coupling hotspots,
 * and fallback traps.
 */
export const diagnoseCommand: DadTestCommand = {
  options: diagnoseOptions,
  execute: async (parsed, io, json) => {
    const manifestPath = parsed.values.get("--manifest");
    const diagnosis = await diagnoseTesting({
      workspaceRoot: io.cwd,
      ...(manifestPath === undefined ? {} : { manifestPath }),
      ...(io.nativeBinary === undefined ? {} : { nativeBinary: io.nativeBinary }),
    });
    if (json) {
      writeCommandSuccess(io, json, "diagnose", diagnosis);
    } else {
      io.stdout(renderDiagnosis(diagnosis));
    }
    return 0;
  },
};

/** Renders a human-readable Coupling & Precision X-Ray report. */
export function renderDiagnosis(diagnosis: TestingDiagnoseResult): string {
  const { summary } = diagnosis;
  const lines: string[] = [
    `diagnose: ${String(summary.totalModules)} modules, ${String(summary.totalProjects)} projects, ${String(summary.totalTasks)} tasks, ${String(summary.totalTestFiles)} test files, ${String(summary.totalUncertainties)} uncertainties (${String(summary.wholeWorkspaceUncertainties)} workspace-wide), est. leaf skip ${String(summary.estimatedLeafSkipPercent)}%`,
    `  unowned tracked files: ${String(summary.unownedTrackedFiles)}, uncovered non-code files: ${String(summary.nonCodeUncoveredFiles)}`,
  ];
  appendSection(lines, "Widening culprits", diagnosis.wideningCulprits, formatCulprit);
  appendSection(lines, "Coupling hotspots", diagnosis.couplingHotspots, formatHotspot);
  appendSection(lines, "Fallback traps", diagnosis.fallbackTraps, formatTrap);
  return `${lines.join("\n")}\n`;
}

function appendSection<T>(
  lines: string[],
  heading: string,
  items: readonly T[],
  formatItem: (item: T) => string,
): void {
  lines.push("");
  if (items.length === 0) {
    lines.push(`${heading}: none`);
    return;
  }
  lines.push(`${heading} (${String(items.length)}):`);
  for (const item of items) {
    lines.push(`  ${formatItem(item)}`);
  }
}

function formatCulprit(culprit: TestingWideningCulprit): string {
  const location = formatLocation(culprit.path, culprit.line, culprit.column);
  return `${location} [${culprit.code}] -> widens ${String(culprit.widenedTasks)} tasks / ${String(culprit.widenedTestFiles)} test files`;
}

function formatHotspot(hotspot: TestingCouplingHotspot): string {
  return `${hotspot.path} -> reaches ${String(hotspot.reachedTestFiles)} test files (${String(hotspot.reachedTestPercent)}%) across ${String(hotspot.reachedProjects)} projects`;
}

function formatTrap(trap: TestingFallbackTrap): string {
  const unit = trap.fileCount === 1 ? "file" : "files";
  const sample = trap.samplePaths[0];
  const detail =
    sample === undefined ? `${String(trap.fileCount)} ${unit}` : `${String(trap.fileCount)} ${unit}, e.g. ${sample}`;
  return `[${trap.kind}] ${trap.prefix} (${detail})`;
}

function formatLocation(path: string, line?: number, column?: number): string {
  if (line === undefined) return path;
  if (column === undefined) return `${path}:${String(line)}`;
  return `${path}:${String(line)}:${String(column)}`;
}
