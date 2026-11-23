/**
 * House rules with nothing running behind them: report-only in standard,
 * ceiling 0 in strict.
 *
 * An entrypoint is a document, and a document is a request. What makes a house
 * rule a rule is that something runs when the edit happens — before the tool
 * call, after the write — and answers. Without that, the rules hold exactly as
 * long as the contributor's attention does, which for an automated one is the
 * length of one prompt.
 *
 * The question follows the entrypoint. A repository that has not written its
 * rules down is asked about the writing first, by
 * `agent-entrypoint-missing`; asking the same repository twice would report
 * one absence as two.
 *
 * A configuration counts when it runs a program. Which harness, which event,
 * and what the program decides are all beyond a text reading and beside the
 * point: the failure being measured is that nothing runs at all.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalEvidence, SignalReadings } from "../../doctor-signal.js";
import { agentEntrypointPath, wiredGuards } from "../scanners/text-agent-harness.js";

function countUnwiredHarnesses(context: DoctorContext): SignalReadings {
  const entrypoint = agentEntrypointPath(context);
  if (entrypoint === undefined) return new Map();
  const guards = wiredGuards(context);
  const evidence: readonly SignalEvidence[] =
    guards.length === 0 ? [{ path: entrypoint }] : guards.map((guard) => ({ path: guard.path, name: guard.command }));
  return new Map([["harnesses", { value: guards.length === 0 ? 1 : 0, evidence }]]);
}

export const agentHooksUnwiredSignal: DoctorSignal = {
  id: "agent-hooks-unwired",
  issue: "you-let-the-babysitter-raise-them",
  question: "Is no edit-time guard wired for any agent harness?",
  reads: "text",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: null, strict: 0 },
  sentence: "A rule that only lives in a reviewer’s head is a rule that leaves when the reviewer does.",
  run: (context) => Promise.resolve(countUnwiredHarnesses(context)),
};
