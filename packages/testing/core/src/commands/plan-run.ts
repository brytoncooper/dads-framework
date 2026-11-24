import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OptionSpecification, ParsedArguments } from "../cli-arguments.js";
import { readPositiveInteger } from "../cli-arguments.js";
import { writeCommandSuccess } from "../cli-output.js";
import type { DadTestCliIo, DadTestCommand } from "../dad-test-cli.js";
import { isRecord } from "../parse-guards.js";
import { planTesting, runTesting } from "../testing-api.js";
import type { TestingOperationRequest, TestingPlanResult, TestingRunResult, TestingTaskShard } from "../testing-api.js";
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
  { name: "--kind", kind: "repeatable" },
  { name: "--target", kind: "repeatable" },
  { name: "--project", kind: "repeatable" },
  { name: "--exclude", kind: "repeatable" },
  { name: "--shard", kind: "value" },
  { name: "--weights", kind: "value" },
  { name: "--jobs", kind: "value" },
  { name: "--report", kind: "optional-value" },
];

const runOptions: readonly OptionSpecification[] = [
  ...operationOptions,
  { name: "--cache", kind: "flag" },
  { name: "--no-cache", kind: "flag" },
  { name: "--remote-cache", kind: "value" },
  { name: "--stream", kind: "flag" },
];

export const planCommand: DadTestCommand = {
  options: operationOptions,
  execute: async (parsed, io, json) => {
    const plan = await planTesting(buildOperationRequest(parsed, io));
    const report = buildReportIfRequested(parsed, io, plan);
    writeCommandSuccess(io, json, "plan", report === undefined ? plan : { ...plan, report });
    writeReportWrittenLine(parsed, io, json, report);
    return 0;
  },
};

export const runCommand: DadTestCommand = {
  options: runOptions,
  execute: async (parsed, io, json) => {
    const request = buildOperationRequest(parsed, io);
    const shouldStream = parsed.flags.has("--stream") || !json;
    const result = await runTesting({
      ...request,
      ...(shouldStream
        ? {
            stream: true,
            onStream: (chunk) => {
              io.stderr(chunk);
            },
          }
        : {}),
    });
    const report = buildReportIfRequested(parsed, io, result.plan, result.run);
    writeCommandSuccess(
      io,
      json,
      "run",
      report === undefined ? result : { plan: result.plan, run: result.run, report },
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
export function buildOperationRequest(parsed: ParsedArguments, io: DadTestCliIo): TestingOperationRequest {
  return {
    workspaceRoot: io.cwd,
    all: parsed.flags.has("--all"),
    taskIds: parsed.repeated.get("--task") ?? [],
    ...optionalSelectionFields(parsed, io.cwd),
    ...optionalExecutionFields(parsed, io),
  };
}

function optionalSelectionFields(parsed: ParsedArguments, cwd: string): Partial<TestingOperationRequest> {
  const manifestPath = parsed.values.get("--manifest");
  const base = parsed.values.get("--base");
  const head = parsed.values.get("--head");
  const shardRaw = parsed.values.get("--shard");
  const weightsPath = parsed.values.get("--weights");
  return {
    ...(manifestPath === undefined ? {} : { manifestPath }),
    ...(base === undefined ? {} : { base }),
    ...(head === undefined ? {} : { head }),
    ...(shardRaw === undefined ? {} : { shard: parseShardOption(shardRaw) }),
    ...(weightsPath === undefined ? {} : { shardWeights: loadShardWeightsFile(cwd, weightsPath) }),
    ...optionalFilterLists(parsed),
  };
}

function optionalFilterLists(parsed: ParsedArguments): Partial<TestingOperationRequest> {
  const taskKinds = splitCommaValues(parsed.repeated.get("--kind") ?? []);
  const targets = splitCommaValues(parsed.repeated.get("--target") ?? []);
  const projects = splitCommaValues(parsed.repeated.get("--project") ?? []);
  const excludeProjects = splitCommaValues(parsed.repeated.get("--exclude") ?? []);
  return {
    ...(taskKinds.length === 0 ? {} : { taskKinds }),
    ...(targets.length === 0 ? {} : { targets }),
    ...(projects.length === 0 ? {} : { projects }),
    ...(excludeProjects.length === 0 ? {} : { excludeProjects }),
  };
}

function splitCommaValues(values: readonly string[]): readonly string[] {
  const result: string[] = [];
  for (const raw of values) {
    for (const part of raw.split(",")) {
      const trimmed = part.trim();
      if (trimmed.length > 0 && !result.includes(trimmed)) result.push(trimmed);
    }
  }
  return result;
}

function loadShardWeightsFile(cwd: string, weightsPath: string): Readonly<Record<string, number>> {
  const raw: unknown = JSON.parse(readFileSync(resolve(cwd, weightsPath), "utf8"));
  if (!isRecord(raw)) {
    throw new Error(`--weights file '${weightsPath}' must be a JSON object mapping project or task IDs to numbers.`);
  }
  const weights: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`--weights entry '${key}' in '${weightsPath}' must be a positive finite number.`);
    }
    weights[key] = value;
  }
  return weights;
}

function optionalExecutionFields(parsed: ParsedArguments, io: DadTestCliIo): Partial<TestingOperationRequest> {
  const jobs = parsed.values.get("--jobs");
  const cacheEnabled = parsed.flags.has("--cache") && !parsed.flags.has("--no-cache");
  const remoteCacheUrl = parsed.values.get("--remote-cache");
  return {
    ...(jobs === undefined ? {} : { jobs: readPositiveInteger(jobs, "--jobs") }),
    ...(cacheEnabled ? { cache: true } : {}),
    ...(remoteCacheUrl === undefined ? {} : { remoteCacheUrl }),
    ...(io.nativeBinary === undefined ? {} : { nativeBinary: io.nativeBinary }),
  };
}

function parseShardOption(raw: string): TestingTaskShard {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(raw.trim());
  if (match === null) {
    throw new Error(`Invalid --shard value '${raw}'. Expected '<index>/<total>' (for example, '1/4').`);
  }
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index < 1 || index > total) {
    throw new Error(`Invalid --shard value '${raw}'. Index must be between 1 and total.`);
  }
  return { index, total };
}
