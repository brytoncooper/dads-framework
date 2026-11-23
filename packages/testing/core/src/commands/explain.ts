import type { OptionSpecification } from "../cli-arguments.js";
import { writeCommandSuccess } from "../cli-output.js";
import type { DadTestCommand } from "../dad-test-cli.js";
import { explainPlan, renderPlanExplanation } from "../explain-plan.js";
import { planTesting } from "../testing-api.js";
import { readTestingManifest } from "../testing-manifest.js";
import { buildOperationRequest } from "./plan-run.js";

/**
 * `explain` selects the same scope as `plan`, so it accepts the same options
 * minus `--jobs`: explaining a plan runs nothing and has no worker limit.
 */
const explainOptions: readonly OptionSpecification[] = [
  { name: "--manifest", kind: "value" },
  { name: "--base", kind: "value" },
  { name: "--head", kind: "value" },
  { name: "--all", kind: "flag" },
  { name: "--task", kind: "repeatable" },
];

/**
 * `dad-test explain` reports the evidence behind a plan. The manifest is read
 * here rather than inside the explanation so an unreadable manifest fails the
 * command with its own message instead of quietly producing a thinner report.
 */
export const explainCommand: DadTestCommand = {
  options: explainOptions,
  execute: async (parsed, io, json) => {
    const plan = await planTesting(buildOperationRequest(parsed, io));
    const manifest = readTestingManifest(io.cwd, parsed.values.get("--manifest"));
    const explanation = explainPlan(plan, manifest);
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
