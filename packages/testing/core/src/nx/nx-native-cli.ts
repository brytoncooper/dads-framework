import { parseArgs } from "node:util";
import { renderDiagnosis } from "../commands/diagnose.js";
import {
  diagnoseNativeNxTesting,
  planNativeNxTesting,
  runNativeNxTesting,
  type NativeNxTestingOptions,
} from "./nx-native-workspace.js";

const usageText = [
  "Usage: dad-test-nx <plan|run|diagnose> [workspace] [options]",
  "",
  "Commands:",
  "  plan [workspace]      Select affected Nx targets using Oxc symbol-level reachability",
  "  run [workspace]       Execute selected Nx targets through Nx",
  "  diagnose [workspace]  Inspect widening culprits, coupling hotspots, and fallback traps",
  "",
  "Options:",
  "  --base <ref>          Compare working tree (or --head) against a Git base ref",
  "  --head <ref>          Compare --base..<ref> (must match clean checked-out HEAD)",
  "  --targets <a,b>       Comma-separated exact Nx target names",
  "  --all                 Select every registered verification target",
  "  --jobs <n>            Maximum concurrent tasks during run",
  "  --json                Emit machine-readable JSON output",
  "  -h, --help            Show this help message",
].join("\n");

async function main(): Promise<void> {
  const invocation = readInvocation();
  if (invocation.kind === "help") {
    process.stdout.write(`${usageText}\n`);
    return;
  }
  if (invocation.kind === "diagnose") {
    const result = await diagnoseNativeNxTesting({
      workspaceRoot: invocation.request.workspaceRoot,
      ...(invocation.request.targetNames === undefined ? {} : { targetNames: invocation.request.targetNames }),
    });
    process.stdout.write(
      invocation.json
        ? `${JSON.stringify(result)}\n`
        : `${String(result.coverage.registered)} verification targets registered; ${String(result.coverage.excluded)} targets excluded.\n${renderDiagnosis(result.diagnose)}`,
    );
    return;
  }
  const invoke = invocation.kind === "run" ? runNativeNxTesting : planNativeNxTesting;
  const result = await invoke(invocation.request);
  process.stdout.write(
    invocation.json
      ? `${JSON.stringify(result)}\n`
      : `${String(result.coverage.registered)} verification targets registered; ${String(result.coverage.excluded)} targets excluded.\n${String(result.plan.counts.run)} selected, ${String(result.plan.counts.skipProvenUnaffected)} proven unaffected. Nx owns prerequisite execution; see --json for coverage reasons.\n`,
  );
  process.exitCode = result.run?.exitCode ?? 0;
}

type CliInvocation =
  | { readonly kind: "help" }
  | { readonly kind: "plan" | "run" | "diagnose"; readonly request: NativeNxTestingOptions; readonly json: boolean };

function readInvocation(): CliInvocation {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: "string" },
      head: { type: "string" },
      targets: { type: "string" },
      jobs: { type: "string" },
      all: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [operation, workspaceRoot = process.cwd()] = positionals;
  if (values.help === true || operation === "help") {
    return { kind: "help" as const };
  }
  if ((operation !== "plan" && operation !== "run" && operation !== "diagnose") || positionals.length > 2) {
    throw new Error(
      "Usage: dad-test-nx plan|run|diagnose [workspace] [--base ref] [--head ref] [--targets test,lint] [--all] [--jobs n] [--json]",
    );
  }
  return {
    kind: operation,
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
