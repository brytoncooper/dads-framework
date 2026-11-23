import { parseArgs } from "node:util";
import { planNativeNxTesting, runNativeNxTesting, type NativeNxTestingOptions } from "./nx-native-workspace.js";

async function main(): Promise<void> {
  const { operation, request, json } = readInvocation();
  const invoke = operation === "run" ? runNativeNxTesting : planNativeNxTesting;
  const result = await invoke(request);
  process.stdout.write(
    json
      ? `${JSON.stringify(result)}\n`
      : `${String(result.coverage.registered)} verification targets registered; ${String(result.coverage.excluded)} targets excluded.\n${String(result.plan.counts.run)} selected, ${String(result.plan.counts.skipProvenUnaffected)} proven unaffected. Nx owns prerequisite execution; see --json for coverage reasons.\n`,
  );
  process.exitCode = result.run?.exitCode ?? 0;
}

function readInvocation() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: "string" },
      head: { type: "string" },
      targets: { type: "string" },
      jobs: { type: "string" },
      all: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  const [operation, workspaceRoot = process.cwd()] = positionals;
  if ((operation !== "plan" && operation !== "run") || positionals.length > 2) {
    throw new Error(
      "Usage: dad-test-nx plan|run [workspace] [--base ref] [--head ref] [--targets test,lint] [--all] [--jobs n] [--json]",
    );
  }
  return {
    operation,
    request: readOptions(workspaceRoot, values),
    json: values.json === true,
  };
}

function readOptions(
  workspaceRoot: string,
  values: {
    readonly base?: string;
    readonly head?: string;
    readonly all?: boolean;
    readonly jobs?: string;
    readonly targets?: string;
  },
): NativeNxTestingOptions {
  const jobs = readJobs(values.jobs);
  const targetNames = readTargets(values.targets);
  return {
    workspaceRoot,
    ...(values.base === undefined ? {} : { base: values.base }),
    ...(values.head === undefined ? {} : { head: values.head }),
    ...(values.all === undefined ? {} : { all: values.all }),
    ...(jobs === undefined ? {} : { jobs }),
    ...(targetNames === undefined ? {} : { targetNames }),
  };
}

function readJobs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const jobs = Number(value);
  if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error("--jobs must be a positive integer.");
  return jobs;
}

function readTargets(value: string | undefined): readonly string[] | undefined {
  const targets = value?.split(",");
  if (targets?.some((target) => target.trim() === ""))
    throw new Error("--targets requires non-empty exact target names.");
  return targets;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Nx adapter failed."}\n`);
  process.exitCode = 1;
});
