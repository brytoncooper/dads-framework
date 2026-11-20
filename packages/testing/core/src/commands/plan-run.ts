import { resolve } from "node:path";
import type { OptionSpecification, ParsedArguments } from "../cli-arguments.js";
import { readPositiveInteger } from "../cli-arguments.js";
import { writeCommandSuccess } from "../cli-output.js";
import type { DadTestCliIo, DadTestCommand } from "../dad-test-cli.js";
import { planTesting, runTesting } from "../testing-api.js";
import type {
  TestingOperationRequest,
  TestingPlanResult,
  TestingRunResult,
} from "../testing-api.js";
import { readTestingManifest } from "../testing-manifest.js";
import { buildTestingReport } from "../testing-report.js";
import type { TestingReport } from "../testing-report.js";
import { writeFilesAtomically } from "../write-files-atomically.js";

/** `plan` and `run` select the same scope, so they accept the same options. */
const operationOptions: readonly OptionSpecification[] = [
  { name: "--manifest", kind: "value" },
  { name: "--base", kind: "value" },
  { name: "--head", kind: "value" },
  { name: "--all", kind: "flag" },
  { name: "--task", kind: "repeatable" },
  { name: "--jobs", kind: "value" },
  { name: "--report", kind: "optional-value" },
];

export const planCommand: DadTestCommand = {
  options: operationOptions,
  execute: async (parsed, io, json) => {
    const plan = await planTesting(buildOperationRequest(parsed, io));
    const report = buildReportIfRequested(parsed, io, plan);
    writeCommandSuccess(
      io,
      json,
      "plan",
      report === undefined ? plan : { ...plan, report },
    );
    writeReportWrittenLine(parsed, io, json, report);
    return 0;
  },
};

export const runCommand: DadTestCommand = {
  options: operationOptions,
  execute: async (parsed, io, json) => {
    const result = await runTesting(buildOperationRequest(parsed, io));
    const report = buildReportIfRequested(parsed, io, result.plan, result.run);
    writeCommandSuccess(
      io,
      json,
      "run",
      report === undefined
        ? result
        : { plan: result.plan, run: result.run, report },
    );
    writeReportWrittenLine(parsed, io, json, report);
    return result.run.exitCode;
  },
};

/**
 * Builds the `--report` output when `--report` was given, reading the manifest
 * only in that case: without `--report`, `plan`/`run` output must stay exactly
 * what it was before this option existed.
 */
function buildReportIfRequested(
  parsed: ParsedArguments,
  io: DadTestCliIo,
  plan: TestingPlanResult,
  run?: TestingRunResult,
): TestingReport | undefined {
  if (!parsed.present.has("--report")) return undefined;
  const manifest = readTestingManifest(io.cwd, parsed.values.get("--manifest"));
  const report = buildTestingReport({
    plan,
    manifest,
    ...(run === undefined ? {} : { run }),
  });
  const reportPath = parsed.values.get("--report");
  if (reportPath !== undefined) {
    writeFilesAtomically([
      {
        path: resolve(io.cwd, reportPath),
        contents: `${JSON.stringify(report, null, 2)}\n`,
      },
    ]);
  }
  return report;
}

/** In human mode only, names the file `--report` wrote, after the normal output. */
function writeReportWrittenLine(
  parsed: ParsedArguments,
  io: DadTestCliIo,
  json: boolean,
  report: TestingReport | undefined,
): void {
  if (json || report === undefined) return;
  const reportPath = parsed.values.get("--report");
  if (reportPath === undefined) return;
  io.stdout(`report written: ${reportPath}\n`);
}

/** Builds the one request the native engine receives for `plan` and `run`. */
export function buildOperationRequest(
  parsed: ParsedArguments,
  io: DadTestCliIo,
): TestingOperationRequest {
  const manifestPath = parsed.values.get("--manifest");
  const base = parsed.values.get("--base");
  const head = parsed.values.get("--head");
  const jobs = parsed.values.get("--jobs");
  return {
    workspaceRoot: io.cwd,
    ...(manifestPath === undefined ? {} : { manifestPath }),
    ...(base === undefined ? {} : { base }),
    ...(head === undefined ? {} : { head }),
    all: parsed.flags.has("--all"),
    taskIds: parsed.repeated.get("--task") ?? [],
    ...(jobs === undefined
      ? {}
      : { jobs: readPositiveInteger(jobs, "--jobs") }),
    ...(io.nativeBinary === undefined ? {} : { nativeBinary: io.nativeBinary }),
  };
}
