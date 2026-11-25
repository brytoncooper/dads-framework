import type { OptionSpecification, ParsedArguments } from "../cli-arguments.js";
import { writeCommandSuccess } from "../cli-output.js";
import type { DadTestCliIo, DadTestCommand } from "../dad-test-cli.js";
import { initDiscoverManifest, type DiscoverInitResult } from "../init/discover-init.js";
import { initTestingManifest } from "../init/init-testing-manifest.js";
import type { InitTestingManifestResult } from "../init/init-testing-manifest.js";

const initOptions: readonly OptionSpecification[] = [
  { name: "--manifest", kind: "value" },
  { name: "--force", kind: "flag" },
  { name: "--discover", kind: "flag" },
];

/**
 * `dad-test init` generates a manifest for a workspace that has none. The human
 * form leads with what was written and how it was checked, then names every
 * package it skipped and everything it could not read — the two things that
 * decide whether the generated manifest is worth keeping.
 *
 * With `--discover`, it writes a compact declarative `workspace.discover`
 * manifest instead of enumerating every project and task statically.
 */
export const initCommand: DadTestCommand = {
  options: initOptions,
  execute: async (parsed, io, json) => {
    if (parsed.flags.has("--discover")) {
      return executeDiscoverInit(parsed, io, json);
    }
    return executeStaticInit(parsed, io, json);
  },
};

async function executeDiscoverInit(parsed: ParsedArguments, io: DadTestCliIo, json: boolean): Promise<number> {
  const manifestPath = parsed.values.get("--manifest");
  const result = await initDiscoverManifest({
    workspaceRoot: io.cwd,
    ...(manifestPath === undefined ? {} : { manifestPath }),
    force: parsed.flags.has("--force"),
    ...(io.nativeBinary === undefined ? {} : { nativeBinary: io.nativeBinary }),
    environment: io.env,
  });
  if (json) {
    writeCommandSuccess(io, true, "init", result);
    return 0;
  }
  writeDiscoverHumanReport(io, result);
  return 0;
}

async function executeStaticInit(parsed: ParsedArguments, io: DadTestCliIo, json: boolean): Promise<number> {
  const manifestPath = parsed.values.get("--manifest");
  const result = await initTestingManifest({
    workspaceRoot: io.cwd,
    ...(manifestPath === undefined ? {} : { manifestPath }),
    force: parsed.flags.has("--force"),
    ...(io.nativeBinary === undefined ? {} : { nativeBinary: io.nativeBinary }),
    environment: io.env,
  });
  if (json) {
    writeCommandSuccess(io, true, "init", result);
    return 0;
  }
  writeHumanReport(io, result);
  return 0;
}

function writeDiscoverHumanReport(io: DadTestCliIo, result: DiscoverInitResult): void {
  const { validation } = result;
  const counted = `${count(validation.projectCount, "project")}, ${count(validation.taskCount, "task")}`;
  const factories = result.pureFactories.length === 0 ? "none" : result.pureFactories.join(", ");
  const ignores = result.ignorePaths.length === 0 ? "none" : result.ignorePaths.join(", ");
  const lines = [
    `init --discover: wrote ${result.manifestPath} (${counted}) validation=${validation.method}`,
    `  pureFactories: ${factories}`,
    `  ignorePaths: ${ignores}`,
  ];
  if (result.setupFiles.length > 0) {
    lines.push(`  setupFiles: ${result.setupFiles.join(", ")}`);
  }
  if (result.sqlMigrationRoots.length > 0) {
    lines.push(`  sql.migrationRoots: ${result.sqlMigrationRoots.join(", ")}`);
  }
  lines.push(`Next: ${result.nextStep}`);
  io.stdout(`${lines.join("\n")}\n`);
}

function writeHumanReport(io: DadTestCliIo, result: InitTestingManifestResult): void {
  const validation = result.report.validation;
  const selected =
    validation.selectedTaskCount === undefined ? "" : ` selected=${String(validation.selectedTaskCount)}`;
  const counted = `${count(result.manifest.projects.length, "project")}, ${count(result.manifest.tasks.length, "task")}`;
  const lines = [
    `init: wrote ${result.manifestPath} (${counted}) validation=${validation.method}${selected}`,
    `report: ${result.reportPath}`,
  ];
  for (const entry of result.report.packages) {
    if (entry.skipped === undefined) continue;
    lines.push(`skipped ${entry.directory}: ${entry.skipped}`);
  }
  for (const entry of result.report.unsupported) {
    lines.push(`unsupported ${entry.subject}: ${entry.message}`);
  }
  io.stdout(`${lines.join("\n")}\n`);
}

function count(total: number, noun: string): string {
  return `${String(total)} ${noun}${total === 1 ? "" : "s"}`;
}
