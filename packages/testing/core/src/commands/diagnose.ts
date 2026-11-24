import { existsSync } from "node:fs";
import { join } from "node:path";
import type { OptionSpecification } from "../cli-arguments.js";
import { writeCommandSuccess } from "../cli-output.js";
import type { DadTestCommand } from "../dad-test-cli.js";
import { diagnoseNativeNxTesting } from "../nx/nx-native-workspace.js";
import { diagnoseTesting } from "../testing-api.js";
import type {
  TestingCouplingHotspot,
  TestingDiagnoseRemediation,
  TestingDiagnoseResult,
  TestingFallbackTrap,
  TestingWideningCulprit,
} from "../testing-api.js";
import { defaultTestingManifestFileName } from "../testing-manifest.js";

const diagnoseOptions: readonly OptionSpecification[] = [
  { name: "--manifest", kind: "value" },
  { name: "--max-workspace-uncertainties", kind: "value" },
  { name: "--fail-on-workspace-uncertainties", kind: "flag" },
  { name: "--max-unowned-files", kind: "value" },
];

/**
 * `dad-test diagnose` inspects the workspace's dependency graph and manifest
 * without requiring a Git diff, reporting widening culprits, coupling hotspots,
 * fallback traps, and safety-tiered remediation guidance.
 *
 * When invoked in an Nx workspace without a `dads.testing.json`, it runs
 * diagnosis directly through the native Nx adapter so the quickstart works
 * with zero hand-authored manifest.
 */
export const diagnoseCommand: DadTestCommand = {
  options: diagnoseOptions,
  execute: async (parsed, io, json) => {
    const manifestPath = parsed.values.get("--manifest");
    const maxWorkspace = resolveMaxWorkspaceThreshold(parsed);
    const maxUnowned = parseOptionalNonNegativeInt(parsed.values.get("--max-unowned-files"), "--max-unowned-files");
    const diagnosis = await runDiagnosis(io.cwd, manifestPath, io.nativeBinary);
    if (json) {
      writeCommandSuccess(io, json, "diagnose", diagnosis);
    } else {
      io.stdout(renderDiagnosis(diagnosis));
    }
    const failures = checkDiagnoseThresholds(diagnosis, maxWorkspace, maxUnowned);
    if (failures.length > 0) {
      io.stderr(`${failures.join("\n")}\n`);
      return 1;
    }
    return 0;
  },
};

function resolveMaxWorkspaceThreshold(parsed: {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
}): number | undefined {
  const explicit = parseOptionalNonNegativeInt(
    parsed.values.get("--max-workspace-uncertainties"),
    "--max-workspace-uncertainties",
  );
  if (parsed.flags.has("--fail-on-workspace-uncertainties")) {
    return explicit === undefined ? 0 : Math.min(0, explicit);
  }
  return explicit;
}

function parseOptionalNonNegativeInt(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${flag} requires a non-negative integer, received '${raw}'.`);
  }
  return Number.parseInt(raw, 10);
}

function checkDiagnoseThresholds(
  diagnosis: TestingDiagnoseResult,
  maxWorkspace: number | undefined,
  maxUnowned: number | undefined,
): string[] {
  const failures: string[] = [];
  const wsCount = diagnosis.summary.wholeWorkspaceUncertainties;
  if (maxWorkspace !== undefined && wsCount > maxWorkspace) {
    failures.push(
      `diagnose threshold exceeded: ${String(wsCount)} workspace-wide uncertainties (max allowed: ${String(maxWorkspace)}).`,
    );
    const culprits = diagnosis.workspaceUncertainties;
    for (const culprit of culprits) {
      const projectLabel = culprit.project === undefined ? "unowned" : culprit.project;
      failures.push(
        `  - ${formatLocation(culprit.path, culprit.line, culprit.column)} [${culprit.code}] (${projectLabel})`,
      );
      failures.push(`    fix: ${culprit.remediation.action}`);
    }
  }
  const unownedCount = diagnosis.summary.unownedTrackedFiles;
  if (maxUnowned !== undefined && unownedCount > maxUnowned) {
    failures.push(
      `diagnose threshold exceeded: ${String(unownedCount)} unowned tracked files (max allowed: ${String(maxUnowned)}).`,
    );
  }
  return failures;
}

async function runDiagnosis(
  workspaceRoot: string,
  manifestPath: string | undefined,
  nativeBinary: string | undefined,
): Promise<TestingDiagnoseResult> {
  if (shouldDiagnoseViaNx(workspaceRoot, manifestPath)) {
    const nxResult = await diagnoseNativeNxTesting({
      workspaceRoot,
      ...(nativeBinary === undefined ? {} : { nativeBinary }),
    });
    return nxResult.diagnose;
  }
  try {
    return await diagnoseTesting({
      workspaceRoot,
      ...(manifestPath === undefined ? {} : { manifestPath }),
      ...(nativeBinary === undefined ? {} : { nativeBinary }),
    });
  } catch (error: unknown) {
    throw enrichMissingManifestError(error, manifestPath);
  }
}

function shouldDiagnoseViaNx(workspaceRoot: string, manifestPath: string | undefined): boolean {
  return (
    manifestPath === undefined &&
    !existsSync(join(workspaceRoot, defaultTestingManifestFileName)) &&
    existsSync(join(workspaceRoot, "nx.json"))
  );
}

function enrichMissingManifestError(error: unknown, manifestPath: string | undefined): unknown {
  if (
    manifestPath === undefined &&
    error instanceof Error &&
    /Unable to resolve manifestPath|No such file or directory/i.test(error.message)
  ) {
    return new Error(
      `No ${defaultTestingManifestFileName} found. Run 'dad-test init' to generate one, pass --manifest <path>, or use 'dad-test-nx diagnose' in an Nx workspace.`,
      { cause: error },
    );
  }
  return error;
}

/** Renders a human-readable Coupling & Precision X-Ray report with safe remediation guidance. */
export function renderDiagnosis(diagnosis: TestingDiagnoseResult): string {
  const { summary } = diagnosis;
  const skipSummary =
    summary.estimatedLeafSkipPercent === summary.potentialLeafSkipPercent
      ? `${String(summary.estimatedLeafSkipPercent)}% effective`
      : `${String(summary.estimatedLeafSkipPercent)}% effective today -> ${String(summary.potentialLeafSkipPercent)}% potential after fixing widening culprits`;
  const lines: string[] = [
    `diagnose: ${plural(summary.totalModules, "module")}, ${plural(summary.totalProjects, "project")}, ${plural(summary.totalTasks, "task")}, ${plural(summary.totalTestFiles, "test file")}, ${plural(summary.totalUncertainties, "uncertainty", "uncertainties")} (${String(summary.wholeWorkspaceUncertainties)} workspace-wide)`,
    `  leaf skip: ${skipSummary}`,
    `  unowned tracked files: ${String(summary.unownedTrackedFiles)}, uncovered non-code files: ${String(summary.nonCodeUncoveredFiles)}`,
  ];
  if (diagnosis.workspaceUncertainties.length > 0) {
    appendSection(lines, "Workspace-wide uncertainties", diagnosis.workspaceUncertainties, formatCulprit);
  }
  appendSection(lines, "Widening culprits", diagnosis.wideningCulprits, formatCulprit);
  appendSection(lines, "Coupling hotspots", diagnosis.couplingHotspots, formatHotspot);
  appendSection(lines, "Fallback traps", diagnosis.fallbackTraps, formatTrap);
  return `${lines.join("\n")}\n`;
}

function appendSection<T extends { readonly remediation: TestingDiagnoseRemediation }>(
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
    lines.push(`    fix [${item.remediation.safety}]: ${item.remediation.action}`);
    lines.push(`    caution: ${item.remediation.caution}`);
  }
}

function formatCulprit(culprit: TestingWideningCulprit): string {
  const location = formatLocation(culprit.path, culprit.line, culprit.column);
  const scopeNote = culprit.scope === "workspace" ? " (worst-case workspace-wide)" : "";
  return `${location} [${culprit.code}] -> widens ${plural(culprit.widenedTasks, "task")} / ${plural(culprit.widenedTestFiles, "test file")}${scopeNote}`;
}

function formatHotspot(hotspot: TestingCouplingHotspot): string {
  const typeNote =
    hotspot.typecheckReachedTestFiles > hotspot.reachedTestFiles
      ? ` / ${String(hotspot.typecheckReachedTestFiles)} with types${hotspot.reachedTestFiles === 0 ? " (type-only)" : ""}`
      : "";
  return `${hotspot.path} -> reaches ${plural(hotspot.reachedTestFiles, "runtime test file")} (${String(hotspot.reachedTestPercent)}%)${typeNote} across ${plural(hotspot.reachedProjects, "project")}`;
}

function formatTrap(trap: TestingFallbackTrap): string {
  const countText = plural(trap.fileCount, "file");
  const sample = trap.samplePaths[0];
  const detail = sample === undefined ? countText : `${countText}, e.g. ${sample}`;
  return `[${trap.kind}] ${trap.prefix} (${detail})`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : pluralForm}`;
}

function formatLocation(path: string, line?: number, column?: number): string {
  if (line === undefined) return path;
  if (column === undefined) return `${path}:${String(line)}`;
  return `${path}:${String(line)}:${String(column)}`;
}
