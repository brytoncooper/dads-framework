/**
 * Continuous integration that does not run the gate: ceiling 0.
 *
 * Every other reading in this issue is about a rule existing. This one is
 * about the rule running when nobody is watching. A gate that only runs on the
 * machine of whoever remembered to run it is a gate that stops applying the
 * first busy afternoon, and the person it stops applying for is never the one
 * who wrote it.
 *
 * The gate is whatever the repository calls it: the root manifest's `verify`
 * script, which is the name Dads uses and the one an adopting repository keeps.
 * A repository that declares no such script is asked nothing here, because a
 * doctor that guessed at the name would report every project in the world for
 * not running a command it invented.
 *
 * The workflow list is well-known locations rather than a search, so a
 * document quoting the command is not mistaken for a machine running it.
 */

import { isRecord, isString } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReadings } from "../../doctor-signal.js";
import { ciWorkflowFiles } from "../scanners/text-ci-workflows.js";

const ROOT_MANIFEST = "package.json";
const GATE_SCRIPT = "verify";
const RUNNERS = "npm|pnpm|yarn|bun|make|just";

/** True when the repository's root manifest declares the gate. */
function declaresTheGate(context: DoctorContext): boolean {
  if (!context.exists(ROOT_MANIFEST)) return false;
  const parsed: unknown = JSON.parse(context.read(ROOT_MANIFEST));
  const scripts: unknown = isRecord(parsed) ? parsed["scripts"] : undefined;
  return isRecord(scripts) && isString(scripts[GATE_SCRIPT]);
}

const SHARED_CI_SCRIPT = "ci/verify.sh";
const END_OF_COMMAND = `(?=$|[\\s"';&|])`;
const invokesVerify = new RegExp(`\\b(?:${RUNNERS})\\s+(?:run\\s+)?${GATE_SCRIPT}${END_OF_COMMAND}`);
const invokesSharedScript = new RegExp(`(?:\\bsh\\s+(?:\\./)?|\\./)ci/verify\\.sh${END_OF_COMMAND}`);

function hasInvocation(text: string, invocation: RegExp): boolean {
  return text.split("\n").some((line) => !line.trimStart().startsWith("#") && invocation.test(line));
}

function findWorkflowRunningTheGate(context: DoctorContext, workflows: readonly string[]): string | undefined {
  const sharedScriptRunsVerify =
    context.exists(SHARED_CI_SCRIPT) && hasInvocation(context.read(SHARED_CI_SCRIPT), invokesVerify);
  return workflows.find((path) => {
    const workflow = context.read(path);
    return (
      hasInvocation(workflow, invokesVerify) || (sharedScriptRunsVerify && hasInvocation(workflow, invokesSharedScript))
    );
  });
}

function countWorkflowsWithoutTheGate(context: DoctorContext): SignalReadings {
  if (!declaresTheGate(context)) return new Map();
  const workflows = ciWorkflowFiles(context.files());
  const running = findWorkflowRunningTheGate(context, workflows);
  if (running === undefined) {
    context.notes?.push(
      workflows.length === 0 ? "no recognized CI workflow" : "no recognized CI workflow invokes the verify script",
    );
  }
  return new Map([
    [
      GATE_SCRIPT,
      {
        value: running === undefined ? 1 : 0,
        evidence: [{ path: running ?? ROOT_MANIFEST, name: GATE_SCRIPT }],
      },
    ],
  ]);
}

export const ciWithoutVerifySignal: DoctorSignal = {
  id: "ci-without-verify",
  issue: "its-not-you-its-my-boundaries",
  question: "Does no CI workflow run the gate?",
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence:
    "You do not discover a boundary by crossing it and seeing whether anyone gets mad. Someone has to mean no before production does.",
  run: (context) => Promise.resolve(countWorkflowsWithoutTheGate(context)),
};
