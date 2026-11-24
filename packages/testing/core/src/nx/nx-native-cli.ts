import { parseArgs } from "node:util";
import { renderDiagnosis } from "../commands/diagnose.js";
import { ejectNativeNxTesting, type NativeNxEjectOptions, type NativeNxEjectResult } from "./nx-eject-workspace.js";
import {
  diagnoseNativeNxTesting,
  planNativeNxTesting,
  runNativeNxTesting,
  type NativeNxTestingOptions,
} from "./nx-native-workspace.js";

const usageText = [
  "Usage: dad-test-nx <plan|run|diagnose|eject> [workspace] [options]",
  "",
  "Commands:",
  "  plan [workspace]      Select affected Nx targets using Oxc symbol-level reachability",
  "  run [workspace]       Execute selected Nx targets through Nx",
  "  diagnose [workspace]  Inspect widening culprits, coupling hotspots, and fallback traps",
  "  eject [workspace]     Generate a standalone zero-Nx dads.testing.json (dry-run unless --write)",
  "",
  "Options:",
  "  --base <ref>             Compare working tree (or --head) against a Git base ref",
  "  --head <ref>             Compare --base..<ref> (must match clean checked-out HEAD)",
  "  --targets <a,b>          Comma-separated exact Nx target names",
  "  --all                    Select every registered verification target",
  "  --jobs <n>               Maximum concurrent tasks during run",
  "  --write                  Write dads.testing.json and eject report (eject only)",
  "  --force                  Overwrite existing dads.testing.json (eject --write)",
  "  --replace-nx-vite-paths  Swap nxViteTsPaths() to dadsTsconfigPaths() (eject --write)",
  "  --json                   Emit machine-readable JSON output",
  "  -h, --help               Show this help message",
].join("\n");

async function main(): Promise<void> {
  const invocation = readInvocation();
  if (invocation.kind === "help") {
    process.stdout.write(`${usageText}\n`);
    return;
  }
  if (invocation.kind === "eject") {
    const result = await ejectNativeNxTesting(invocation.options);
    process.stdout.write(invocation.json ? `${JSON.stringify(result)}\n` : renderEjectSummary(result));
    return;
  }
  if (invocation.kind === "diagnose") {
    await runDiagnoseCli(invocation.request, invocation.json);
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

async function runDiagnoseCli(request: NativeNxTestingOptions, json: boolean): Promise<void> {
  const result = await diagnoseNativeNxTesting({
    workspaceRoot: request.workspaceRoot,
    ...(request.targetNames === undefined ? {} : { targetNames: request.targetNames }),
  });
  process.stdout.write(
    json
      ? `${JSON.stringify(result)}\n`
      : `${String(result.coverage.registered)} verification targets registered; ${String(result.coverage.excluded)} targets excluded.\n${renderDiagnosis(result.diagnose)}`,
  );
}

type CliInvocation =
  | { readonly kind: "help" }
  | { readonly kind: "eject"; readonly options: NativeNxEjectOptions; readonly json: boolean }
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
      write: { type: "boolean" },
      force: { type: "boolean" },
      "replace-nx-vite-paths": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [operation, workspaceRoot = process.cwd()] = positionals;
  if (values.help === true || operation === "help") {
    return { kind: "help" };
  }
  if (operation === "eject" && positionals.length <= 2) {
    return readEjectInvocation(workspaceRoot, values);
  }
  if ((operation !== "plan" && operation !== "run" && operation !== "diagnose") || positionals.length > 2) {
    throw new Error(
      "Usage: dad-test-nx plan|run|diagnose|eject [workspace] [--base ref] [--head ref] [--targets test,lint] [--all] [--jobs n] [--write] [--replace-nx-vite-paths] [--json]",
    );
  }
  return {
    kind: operation,
    request: readOptions(workspaceRoot, values),
    json: values.json === true,
  };
}

function readEjectInvocation(
  workspaceRoot: string,
  values: {
    readonly targets?: string;
    readonly write?: boolean;
    readonly force?: boolean;
    readonly "replace-nx-vite-paths"?: boolean;
    readonly json?: boolean;
  },
): CliInvocation {
  const targetNames = readTargets(values.targets);
  return {
    kind: "eject",
    options: {
      workspaceRoot,
      ...(targetNames === undefined ? {} : { targetNames }),
      write: values.write === true,
      force: values.force === true,
      replaceNxViteTsPaths: values["replace-nx-vite-paths"] === true,
    },
    json: values.json === true,
  };
}

function renderEjectSummary(result: NativeNxEjectResult): string {
  const { summary, uninstallCommands } = result.report;
  const header = result.written
    ? `Ejected ${String(summary.converted)} standalone task(s) to ${result.manifestPath} (${String(summary.vitestNarrowed)} with Vitest fileNarrowing, ${String(summary.opaque)} opaque, ${String(summary.excluded)} excluded).`
    : `Dry-run: ${String(summary.converted)} task(s) ready to eject (${String(summary.vitestNarrowed)} with Vitest fileNarrowing, ${String(summary.opaque)} opaque, ${String(summary.excluded)} excluded). Re-run with --write to generate dads.testing.json.`;
  const viteLine =
    summary.nxViteConfigsFound > 0
      ? `nxViteTsPaths configs: ${String(summary.nxViteConfigsFound)} found, ${String(summary.nxViteConfigsRewritten)} rewritten.${summary.nxViteConfigsRewritten < summary.nxViteConfigsFound ? " Pass --write --replace-nx-vite-paths to swap to dadsTsconfigPaths()." : ""}`
      : "nxViteTsPaths configs: none found.";
  const nextSteps = uninstallCommands.map((cmd) => `  ${cmd}`).join("\n");
  return `${header}\n${viteLine}\nNext steps to verify and remove Nx:\n${nextSteps}\n`;
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
