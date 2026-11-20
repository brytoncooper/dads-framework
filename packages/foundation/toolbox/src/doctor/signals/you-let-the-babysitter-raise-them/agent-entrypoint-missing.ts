/**
 * No house rules where an automated contributor will find them: ceiling 0.
 *
 * An agent edits with an author's permissions and reads what is in front of
 * it. A rule in a wiki, in a reviewer's head, or in a pull request from March
 * is a rule it will never see. The entrypoint at the root is the one file
 * every harness loads without being asked, so its absence is not "the rules
 * are elsewhere"; it is "the rules do not reach the contributor".
 *
 * The question is asked of a repository somebody works in, and a root manifest
 * of any ecosystem is the cheapest honest evidence of that. A directory with
 * three files in it is a specimen, and a doctor that asked it for house rules
 * would report every small tree in the world as a finding — including the ones
 * this command's own corpus is made of.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReadings } from "../../doctor-signal.js";
import {
  agentEntrypointPath,
  isWorkingRepository,
} from "../scanners/text-agent-harness.js";

const PREFERRED_ENTRYPOINT = "AGENTS.md";

function countMissingEntrypoints(context: DoctorContext): SignalReadings {
  if (!isWorkingRepository(context)) return new Map();
  const found = agentEntrypointPath(context);
  return new Map([
    [
      "entrypoint",
      {
        value: found === undefined ? 1 : 0,
        evidence: [{ path: found ?? PREFERRED_ENTRYPOINT }],
      },
    ],
  ]);
}

export const agentEntrypointMissingSignal: DoctorSignal = {
  id: "agent-entrypoint-missing",
  issue: "you-let-the-babysitter-raise-them",
  question:
    "Is there no agent entrypoint — `AGENTS.md` or equivalent — at the repository root?",
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence:
    "A rule in a wiki is a rule he will never read. A rule in a hook is a rule he cannot get past.",
  run: (context) => Promise.resolve(countMissingEntrypoints(context)),
};
