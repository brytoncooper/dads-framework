import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { OptionSpecification } from "../cli-arguments.js";
import { writeCommandSuccess } from "../cli-output.js";
import type { DadTestCliIo, DadTestCommand } from "../dad-test-cli.js";
import { explainPlan, renderPlanExplanation } from "../explain-plan.js";
import { isRecord } from "../parse-guards.js";
import { expandTestingManifest, planTesting } from "../testing-api.js";
import { defaultTestingManifestFileName, readTestingManifest, type TestingManifest } from "../testing-manifest.js";
import { buildFocusedTaskExplanation, renderFocusedTaskExplanation } from "./explain-causal.js";
import { buildOperationRequest } from "./plan-run.js";

/**
 * `explain` selects the same scope as `plan`, so it accepts the same options
 * minus `--jobs`: explaining a plan runs nothing and has no worker limit.
 * `--why <taskId>` computes the real diff plan without forcing `--task` and
 * focuses output on one task's 3-line causal chain and 1-line fix.
 */
const explainOptions: readonly OptionSpecification[] = [
  { name: "--manifest", kind: "value" },
  { name: "--base", kind: "value" },
  { name: "--head", kind: "value" },
  { name: "--all", kind: "flag" },
  { name: "--only", kind: "flag" },
  { name: "--task", kind: "repeatable" },
  { name: "--why", kind: "value" },
];

/**
 * `dad-test explain` reports the evidence behind a plan. The manifest is read
 * here rather than inside the explanation so an unreadable manifest fails the
 * command with its own message instead of quietly producing a thinner report.
 */
export const explainCommand: DadTestCommand = {
  options: explainOptions,
  execute: async (parsed, io, json) => {
    const whyTaskId = parsed.values.get("--why");
    if (whyTaskId !== undefined && (parsed.repeated.get("--task")?.length ?? 0) > 0) {
      throw new Error("--why cannot be combined with --task; pass --why alone to inspect the real diff decision.");
    }
    const baseRequest = buildOperationRequest(parsed, io);
    const request = whyTaskId === undefined ? baseRequest : { ...baseRequest, taskIds: [] };
    const plan = await planTesting(request);
    const manifest = await loadManifestForExplain(io, parsed.values.get("--manifest"));
    const explanation = explainPlan(plan, manifest);
    if (whyTaskId !== undefined) {
      const focused = buildFocusedTaskExplanation(explanation, whyTaskId, manifest);
      if (json) {
        writeCommandSuccess(io, json, "explain", focused);
      } else {
        io.stdout(renderFocusedTaskExplanation(focused));
      }
      return 0;
    }
    if (json) {
      writeCommandSuccess(io, json, "explain", explanation);
    } else {
      // The rendered explanation is the whole human output: a "completed"
      // preamble above a report the reader is meant to read is noise.
      io.stdout(renderPlanExplanation(explanation));
    }
    return 0;
  },
};

async function loadManifestForExplain(io: DadTestCliIo, manifestPath: string | undefined): Promise<TestingManifest> {
  try {
    return readTestingManifest(io.cwd, manifestPath);
  } catch (error: unknown) {
    if (!manifestUsesDiscover(io.cwd, manifestPath)) throw error;
    return expandTestingManifest({
      workspaceRoot: io.cwd,
      ...(manifestPath === undefined ? {} : { manifestPath }),
      ...(io.nativeBinary === undefined ? {} : { nativeBinary: io.nativeBinary }),
    });
  }
}

function manifestUsesDiscover(workspaceRoot: string, manifestPath: string | undefined): boolean {
  const root = resolve(workspaceRoot);
  const resolvedPath = resolve(root, manifestPath ?? defaultTestingManifestFileName);
  if (resolvedPath !== root && !resolvedPath.startsWith(`${root}${sep}`)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolvedPath, "utf8"));
    return isRecord(parsed) && isRecord(parsed["workspace"]) && parsed["workspace"]["discover"] !== undefined;
  } catch {
    return false;
  }
}
