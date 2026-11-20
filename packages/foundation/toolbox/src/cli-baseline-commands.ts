import { parseArgs } from "node:util";

import { initializeStandaloneRatchet } from "./doctor/standalone-ratchet.js";
import { BASELINE_PATH } from "./doctor/doctor-gate-model.js";
import { RATCHET_POLICY_PATH } from "./doctor/standalone-ratchet-policy.js";

const USAGE =
  "Usage: dad baseline init [path] --reason <text> [--today YYYY-MM-DD] [--json]";

export async function baselineCommand(
  argumentsAfterCommand: readonly string[],
): Promise<number> {
  if (argumentsAfterCommand[0] !== "init") throw new Error(USAGE);
  const { positionals, values } = parseArgs({
    args: argumentsAfterCommand.slice(1),
    allowPositionals: true,
    options: {
      reason: { type: "string" },
      today: { type: "string" },
      json: { type: "boolean" },
    },
  });
  if (positionals.length > 1 || values.reason === undefined)
    throw new Error(USAGE);
  const today = values.today ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today))
    throw new Error("--today must be YYYY-MM-DD.");
  const result = await initializeStandaloneRatchet({
    root: positionals[0] ?? process.cwd(),
    reason: values.reason,
    today,
  });
  if (values.json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: result.exitCode === 0,
        paths:
          result.exitCode === 0 ? [BASELINE_PATH, RATCHET_POLICY_PATH] : [],
        findings: result.findings,
      })}\n`,
    );
  } else {
    process.stdout.write(result.output);
    if (result.exitCode === 0) {
      process.stdout.write(
        `Review the reasons in ${BASELINE_PATH} and commit it with ${RATCHET_POLICY_PATH}.\n`,
      );
    }
  }
  return result.exitCode;
}
