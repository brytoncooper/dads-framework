import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { OptionSpecification, ParsedArguments } from "../cli-arguments.js";
import { readPositiveInteger } from "../cli-arguments.js";
import { writeCommandSuccess } from "../cli-output.js";
import type { DadTestCliIo, DadTestCommand } from "../dad-test-cli.js";
import { isRecord } from "../parse-guards.js";
import { planTesting, runTesting } from "../testing-api.js";
import type { TestingOperationRequest, TestingPlanResult, TestingRunResult, TestingTaskShard } from "../testing-api.js";
import { buildTestingReport } from "../testing-report.js";
import type { TestingReport } from "../testing-report.js";
import { writeFilesAtomically } from "../write-files-atomically.js";
import { loadTestingManifestForCommand } from "./load-manifest.js";
import { renderShadowVerification, runShadowVerification } from "./verify-shadow.js";

/** `plan` and `run` select the same scope, so they accept the same options. */
const operationOptions: readonly OptionSpecification[] = [
  { name: "--manifest", kind: "value" },
  { name: "--base", kind: "value" },
  { name: "--head", kind: "value" },
  { name: "--all", kind: "flag" },
  { name: "--only", kind: "flag" },
  { name: "--task", kind: "repeatable" },
  { name: "--kind", kind: "repeatable" },
  { name: "--target", kind: "repeatable" },
  { name: "--project", kind: "repeatable" },
  { name: "--exclude", kind: "repeatable" },
  { name: "--shard", kind: "value" },
  { name: "--weights", kind: "value" },
  { name: "--jobs", kind: "value" },
  { name: "--enforce-declared-reads", kind: "flag" },
  { name: "--no-enforce-declared-reads", kind: "flag" },
  { name: "--report", kind: "optional-value" },
];

const runOptions: readonly OptionSpecification[] = [
  ...operationOptions,
  { name: "--plan-file", kind: "value" },
  { name: "--cache", kind: "flag" },
  { name: "--no-cache", kind: "flag" },
  { name: "--cache-dir", kind: "value" },
  { name: "--remote-cache", kind: "value" },
  { name: "--stream", kind: "flag" },
  { name: "--verify-shadow", kind: "flag" },
  { name: "--fail-on-shadow-escape", kind: "flag" },
];

export const planCommand: DadTestCommand = {
  options: operationOptions,
  execute: async (parsed, io, json) => {
    const plan = await planTesting(buildOperationRequest(parsed, io));
    const report = await buildReportIfRequested(parsed, io, plan);
    writeCommandSuccess(io, json, "plan", report === undefined ? plan : { ...plan, report });
    writeReportWrittenLine(parsed, io, json, report);
    return 0;
  },
};

export const runCommand: DadTestCommand = {
  options: runOptions,
  execute: async (parsed, io, json) => {
    const verifyShadow = parsed.flags.has("--verify-shadow");
    const failOnShadowEscape = parsed.flags.has("--fail-on-shadow-escape");
    if (failOnShadowEscape && !verifyShadow) {
      throw new Error("--fail-on-shadow-escape requires --verify-shadow.");
    }
    const request = buildOperationRequest(parsed, io);
    const streamOptions = buildStreamOptions(parsed, io, json);
    const result = await runTesting({ ...request, ...streamOptions });
    const shadow = verifyShadow
      ? await runShadowVerification(request, result, { strict: failOnShadowEscape, ...streamOptions })
      : undefined;
    const report = await buildReportIfRequested(parsed, io, result.plan, result.run);
    emitRunOutput(io, json, result, report, shadow);
    writeReportWrittenLine(parsed, io, json, report);
    return resolveRunExitCode(result.run.exitCode, failOnShadowEscape, shadow);
  },
};

function buildStreamOptions(
  parsed: ParsedArguments,
  io: DadTestCliIo,
  json: boolean,
): { readonly stream?: true; readonly onStream?: (chunk: string) => void } {
  if (!parsed.flags.has("--stream") && json) return {};
  return {
    stream: true,
    onStream: (chunk: string) => {
      io.stderr(chunk);
    },
  };
}

function emitRunOutput(
  io: DadTestCliIo,
  json: boolean,
  result: { readonly plan: TestingPlanResult; readonly run: TestingRunResult },
  report: TestingReport | undefined,
  shadow: Awaited<ReturnType<typeof runShadowVerification>> | undefined,
): void {
  if (json) {
    const payload =
      report === undefined && shadow === undefined
        ? result
        : {
            plan: result.plan,
            run: result.run,
            ...(report === undefined ? {} : { report }),
            ...(shadow === undefined ? {} : { shadowVerification: shadow }),
          };
    writeCommandSuccess(io, true, "run", payload);
    return;
  }
  writeHumanRunSummary(io, result.plan, result.run);
  if (shadow !== undefined) {
    io.stdout(renderShadowVerification(shadow));
  }
}

function resolveRunExitCode(
  primaryExitCode: number,
  failOnShadowEscape: boolean,
  shadow: Awaited<ReturnType<typeof runShadowVerification>> | undefined,
): number {
  if (primaryExitCode !== 0) return primaryExitCode;
  if (failOnShadowEscape && shadow !== undefined && shadow.escapedFailures.length > 0) return 1;
  return 0;
}

function writeHumanRunSummary(io: DadTestCliIo, plan: TestingPlanResult, run: TestingRunResult): void {
  const cached = run.counts.cached ?? 0;
  io.stdout(
    `run completed. ${String(run.counts.executed)} executed (${String(cached)} cached), ${String(run.counts.failed)} failed, ${String(run.counts.blocked)} blocked, ${String(plan.counts.skipProvenUnaffected)} skipped. Use --json for the versioned machine-readable result.\n`,
  );
}

/**
 * Builds the `--report` output when `--report` was given, reading the manifest
 * only in that case: without `--report`, `plan`/`run` output must stay exactly
 * what it was before this option existed.
 */
async function buildReportIfRequested(
  parsed: ParsedArguments,
  io: DadTestCliIo,
  plan: TestingPlanResult,
  run?: TestingRunResult,
): Promise<TestingReport | undefined> {
  if (!parsed.present.has("--report")) return undefined;
  const manifest = await loadTestingManifestForCommand(io, parsed.values.get("--manifest"));
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
    ...(parsed.flags.has("--only") ? { only: true } : {}),
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
  const nestedProjects = raw["projects"];
  if (isRecord(nestedProjects)) {
    return parseNestedProjectWeights(nestedProjects, weightsPath);
  }
  return parseFlatWeights(raw, weightsPath);
}

function parseNestedProjectWeights(
  projects: Record<string, unknown>,
  weightsPath: string,
): Readonly<Record<string, number>> {
  const weights: Record<string, number> = {};
  for (const [project, entry] of Object.entries(projects)) {
    if (typeof entry === "number") {
      if (!Number.isFinite(entry) || entry <= 0) {
        throw new Error(`--weights project '${project}' in '${weightsPath}' must be a positive finite number.`);
      }
      weights[project] = entry;
      continue;
    }
    const durationMs = isRecord(entry) ? entry["durationMs"] : undefined;
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error(
        `--weights project '${project}' in '${weightsPath}' must be a positive number or an object with a non-negative finite 'durationMs'.`,
      );
    }
    weights[project] = durationMs > 0 ? durationMs : 1;
  }
  return weights;
}

function parseFlatWeights(raw: Record<string, unknown>, weightsPath: string): Readonly<Record<string, number>> {
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
  const cacheDir = resolveCacheDirOption(parsed.values.get("--cache-dir"), io.env, io.cwd);
  const remoteCacheUrl = parsed.values.get("--remote-cache");
  const planFile = parsed.values.get("--plan-file");
  return {
    ...(jobs === undefined ? {} : { jobs: readPositiveInteger(jobs, "--jobs") }),
    ...(cacheEnabled ? { cache: true } : {}),
    ...(cacheDir === undefined ? {} : { cacheDir }),
    ...(remoteCacheUrl === undefined ? {} : { remoteCacheUrl }),
    ...(planFile === undefined ? {} : { planFile: resolve(io.cwd, planFile) }),
    ...optionalReadGuardFlags(parsed),
    ...(io.nativeBinary === undefined ? {} : { nativeBinary: io.nativeBinary }),
  };
}

function optionalReadGuardFlags(parsed: ParsedArguments): Partial<TestingOperationRequest> {
  const noEnforce = parsed.flags.has("--no-enforce-declared-reads");
  const enforce = parsed.flags.has("--enforce-declared-reads") && !noEnforce;
  return {
    ...(enforce ? { enforceDeclaredReads: true } : {}),
    ...(noEnforce ? { noEnforceDeclaredReads: true } : {}),
  };
}

function resolveCacheDirOption(flagValue: string | undefined, env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  if (flagValue !== undefined) {
    const trimmed = flagValue.trim();
    if (trimmed.length === 0) {
      throw new Error("--cache-dir must not be empty.");
    }
    return expandAndResolvePath(trimmed, env, cwd);
  }
  const envValue = env["DAD_TEST_CACHE_DIR"]?.trim();
  if (envValue !== undefined && envValue.length > 0) {
    return expandAndResolvePath(envValue, env, cwd);
  }
  return undefined;
}

function expandAndResolvePath(rawPath: string, env: NodeJS.ProcessEnv, cwd: string): string {
  if (rawPath === "~" || rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    const home = env["HOME"] ?? env["USERPROFILE"] ?? homedir();
    return rawPath === "~" ? resolve(home) : resolve(home, rawPath.slice(2));
  }
  return resolve(cwd, rawPath);
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
