/**
 * Every signal this phase ships, and the order they run in.
 *
 * The signals themselves are declared one registry module per lane, under
 * `signals/registry/`, each named for what its lane reads. A lane adding
 * signals edits its own registry and this file never moves, so four lanes can
 * land in one tree without meeting in the middle of an array.
 *
 * Signals that only read text run first, so a repository with no TypeScript,
 * no package declaration and no network still gets a report out of the ones
 * that could answer. Within a group the order is the order the issues appear
 * in `DAD.md`, which is also the order the report prints.
 *
 * A signal that throws is reported against its own name and the rest still
 * run: one unreadable input fails its own line rather than hiding every other
 * reading behind a stack trace.
 */

import type { DoctorContext } from "./doctor-context.js";
import type { DoctorSignal, SignalReadings } from "./doctor-signal.js";
import type { DaddyIssueId } from "./issues.js";
import { FOUNDATION_SIGNALS } from "./signals/registry/foundation.js";
import { GIT_SIGNALS } from "./signals/registry/git.js";
import { ONLINE_SIGNALS } from "./signals/registry/online.js";
import { PACKAGE_SIGNALS } from "./signals/registry/packages.js";
import { ROUTE_SIGNALS } from "./signals/registry/routes.js";
import { STORED_AND_SENT_SIGNALS } from "./signals/registry/stored-and-sent.js";
import { TEXT_AND_PACKAGE_SIGNALS } from "./signals/registry/text-and-packages.js";
import { TYPESCRIPT_SIGNALS } from "./signals/registry/typescript.js";

const DECLARED_SIGNALS: readonly DoctorSignal[] = [
  ...FOUNDATION_SIGNALS,
  ...TEXT_AND_PACKAGE_SIGNALS,
  ...PACKAGE_SIGNALS,
  ...TYPESCRIPT_SIGNALS,
  ...ROUTE_SIGNALS,
  ...GIT_SIGNALS,
  ...STORED_AND_SENT_SIGNALS,
  ...ONLINE_SIGNALS,
];

/** Signals in run order: the ones that only read text, then the rest. */
export const DOCTOR_SIGNALS: readonly DoctorSignal[] = [
  ...DECLARED_SIGNALS.filter((signal) => signal.reads === "text"),
  ...DECLARED_SIGNALS.filter((signal) => signal.reads !== "text"),
];

/** The signals reported under one issue, in run order. */
export function signalsForIssue(issue: DaddyIssueId): readonly DoctorSignal[] {
  return DOCTOR_SIGNALS.filter((signal) => signal.issue === issue);
}

/** What one signal answered, or why it could not answer. */
export type SignalOutcome = {
  readonly signal: DoctorSignal;
  readonly readings: SignalReadings;
  readonly failure: string | undefined;
  /** What the signal said about how it answered, beside the number. */
  readonly notes?: readonly string[];
};

/** Runs the selected signals in order and collects one outcome each. */
export async function runDoctorSignals(
  context: DoctorContext,
  signals: readonly DoctorSignal[],
): Promise<readonly SignalOutcome[]> {
  const outcomes: SignalOutcome[] = [];
  for (const signal of signals) {
    outcomes.push(await runOneSignal(context, signal));
  }
  return outcomes;
}

async function runOneSignal(context: DoctorContext, signal: DoctorSignal): Promise<SignalOutcome> {
  const start = context.notes?.length ?? 0;
  try {
    const readings = await signal.run(context);
    const notes = context.notes?.slice(start) ?? [];
    return { signal, readings, failure: undefined, notes };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "unknown failure";
    return { signal, readings: new Map(), failure: detail };
  }
}
