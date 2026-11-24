import { resolve } from "node:path";

import { writeOutput } from "./cli-io.js";
import { migrateWorkspaceToV03, type MigrateTargetVersion, type MigrateToV03Result } from "./migrate-v03.js";

const SUPPORTED_TARGETS: Readonly<Record<string, MigrateTargetVersion>> = {
  "0.3": "0.3.0",
  "0.3.0": "0.3.0",
  "0.4": "0.4.0",
  "0.4.0": "0.4.0",
  "0.5": "0.5.2",
  "0.5.0": "0.5.0",
  "0.5.1": "0.5.1",
  "0.5.2": "0.5.2",
  "0.6": "0.6.2",
  "0.6.0": "0.6.0",
  "0.6.1": "0.6.1",
  "0.6.2": "0.6.2",
};

export function migrateCommand(args: readonly string[], json: boolean): void {
  const { targetVersion, directory, dryRun, includeMigrations } = parseMigrateArgs(args);

  const result = migrateWorkspaceToV03({
    root: resolve(directory ?? process.cwd()),
    dryRun,
    includeMigrations,
    targetVersion,
  });

  if (json) {
    writeOutput({ ok: true, migration: result }, true);
    return;
  }

  process.stdout.write(`${formatHumanSummary(result)}\n`);
}

function parseMigrateArgs(args: readonly string[]): {
  readonly targetVersion: MigrateTargetVersion;
  readonly directory: string | undefined;
  readonly dryRun: boolean;
  readonly includeMigrations: boolean;
} {
  const positional: string[] = [];
  let dryRun = false;
  let includeMigrations = false;

  for (const argument of args) {
    if (argument === "--json") continue;
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--include-migrations") {
      includeMigrations = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`Unknown migrate option "${argument}".`);
    }
    positional.push(argument);
  }

  const [target, directory] = positional;
  const targetVersion =
    target !== undefined && Object.hasOwn(SUPPORTED_TARGETS, target) ? SUPPORTED_TARGETS[target] : undefined;
  if (targetVersion === undefined) {
    throw new Error(
      `Unsupported migration target ${JSON.stringify(target ?? "")}. Supported targets: 0.3, 0.4, 0.5, 0.6`,
    );
  }

  return { targetVersion, directory, dryRun, includeMigrations };
}

function targetLabel(version: MigrateTargetVersion): string {
  return version.slice(0, 3);
}

function formatHumanSummary(result: MigrateToV03Result): string {
  const label = targetLabel(result.targetVersion);
  if (result.filesChanged.length === 0 && result.skippedMigrations.length === 0 && result.followUps.length === 0) {
    return `Dad migrate ${label}: already up to date (0 files changed).`;
  }

  const lines: string[] = [];
  appendChangedFilesSection(lines, result, label);
  appendSkippedMigrationsSection(lines, result.skippedMigrations);
  appendFollowUpsSection(lines, result.followUps);
  appendNextSteps(lines, result);
  return lines.join("\n");
}

function appendChangedFilesSection(lines: string[], result: MigrateToV03Result, label: string): void {
  if (result.filesChanged.length === 0) {
    lines.push(`Dad migrate ${label}: 0 files changed, but manual follow-up is required.`);
    return;
  }
  const verb = result.dryRun ? "Would update" : "Updated";
  lines.push(
    `Dad migrate ${label}: ${verb} ${String(result.filesChanged.length)} file(s) (${String(result.packageManifestsUpdated)} package.json, ${String(result.importReplacements)} import specifier(s)).`,
  );
  if (result.addedPeers.length > 0) {
    lines.push(`Added newly-optional peer dependencies: ${result.addedPeers.join(", ")}`);
  }
  for (const file of result.filesChanged.slice(0, 25)) {
    lines.push(`  - ${file}`);
  }
  if (result.filesChanged.length > 25) {
    lines.push(`  ... and ${String(result.filesChanged.length - 25)} more file(s)`);
  }
}

function appendSkippedMigrationsSection(lines: string[], skippedMigrations: readonly string[]): void {
  if (skippedMigrations.length === 0) return;
  lines.push("Skipped immutable migration file(s):");
  for (const file of skippedMigrations) {
    lines.push(`  - ${file}`);
  }
}

function appendFollowUpsSection(lines: string[], followUps: readonly string[]): void {
  if (followUps.length === 0) return;
  lines.push("Follow-up actions required:");
  for (const item of followUps) {
    lines.push(`  - ${item}`);
  }
}

function appendNextSteps(lines: string[], result: MigrateToV03Result): void {
  if (result.filesChanged.length === 0) return;
  if (result.dryRun) {
    lines.push("Dry run: no files were written. Re-run without --dry-run to apply.");
  } else {
    lines.push("Next steps: run `npm install && npm run typecheck`.");
  }
}
