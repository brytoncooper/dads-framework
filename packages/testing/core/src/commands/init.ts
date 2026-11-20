import type { OptionSpecification } from "../cli-arguments.js";
import { writeCommandSuccess } from "../cli-output.js";
import type { DadTestCliIo, DadTestCommand } from "../dad-test-cli.js";
import { initTestingManifest } from "../init/init-testing-manifest.js";
import type { InitTestingManifestResult } from "../init/init-testing-manifest.js";

const initOptions: readonly OptionSpecification[] = [
  { name: "--manifest", kind: "value" },
  { name: "--force", kind: "flag" },
];

/**
 * `dad-test init` generates a manifest for a workspace that has none. The human
 * form leads with what was written and how it was checked, then names every
 * package it skipped and everything it could not read — the two things that
 * decide whether the generated manifest is worth keeping.
 */
export const initCommand: DadTestCommand = {
  options: initOptions,
  execute: async (parsed, io, json) => {
    const manifestPath = parsed.values.get("--manifest");
    const result = await initTestingManifest({
      workspaceRoot: io.cwd,
      ...(manifestPath === undefined ? {} : { manifestPath }),
      force: parsed.flags.has("--force"),
      ...(io.nativeBinary === undefined
        ? {}
        : { nativeBinary: io.nativeBinary }),
      environment: io.env,
    });
    if (json) {
      writeCommandSuccess(io, true, "init", result);
      return 0;
    }
    writeHumanReport(io, result);
    return 0;
  },
};

function writeHumanReport(
  io: DadTestCliIo,
  result: InitTestingManifestResult,
): void {
  const validation = result.report.validation;
  const selected =
    validation.selectedTaskCount === undefined
      ? ""
      : ` selected=${String(validation.selectedTaskCount)}`;
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
