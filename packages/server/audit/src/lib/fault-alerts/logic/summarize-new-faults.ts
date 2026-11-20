/**
 * What is worth waking someone for.
 *
 * The judgement that decides whether all the recording is worth anything, and
 * a pure function with its own tests because getting it wrong is silent in
 * both directions: too eager and people stop reading; too quiet and nobody
 * finds out, which is the pain this exists to end.
 *
 * The rule is **new fault types, not fault volume.** A fingerprint nobody has
 * been told about, that is happening now, is the single highest-signal thing
 * this data can say. Volume is deliberately not an alert: a route that fails a
 * thousand times an hour and always has is a known problem, and paging on it
 * teaches people to ignore the channel.
 *
 * Deciding which fingerprints qualify is the reader's job, not this one's —
 * it is a fact in `known_fault_fingerprints`. What is decided here is how many
 * of them one email is allowed to carry, and in what order.
 */

import type {
  FaultGroup,
  FaultOrigin,
} from "../../database/readers/fault-alert-reader.interface.js";

/** One fault as the email renders it. */
export type AlertableFault = {
  readonly fingerprint: string;
  readonly type: string;
  readonly occurrences: number;
  readonly where: string | null;
  readonly origin: FaultOrigin;
};

export type NewFaultSummary = {
  readonly faults: readonly AlertableFault[];
  /** Total across every fault below, so the subject can lead with a number. */
  readonly totalOccurrences: number;
  /** Trimmed because more were found than one email should carry. */
  readonly truncated: boolean;
};

/**
 * The most a digest carries. Past this, the list stops being a thing anyone
 * reads and the right response is to look at the data directly — so the email
 * says so rather than growing without bound.
 *
 * The tail is not dropped, only deferred: the caller remembers what the email
 * listed, so anything trimmed here is still unreported and leads the next
 * sweep.
 */
export const MAX_FAULTS_PER_ALERT = 25;

export function summarizeNewFaults(input: {
  readonly server: readonly FaultGroup[];
  readonly client: readonly FaultGroup[];
}): NewFaultSummary {
  const all = [
    ...input.server.map((group) => alertable(group, "server")),
    ...input.client.map((group) => alertable(group, "client")),
  ]
    // Loudest first: a new fault that has already happened two hundred times
    // is a different conversation from one that happened once.
    .toSorted((left, right) => right.occurrences - left.occurrences);

  return {
    faults: all.slice(0, MAX_FAULTS_PER_ALERT),
    totalOccurrences: all.reduce((sum, fault) => sum + fault.occurrences, 0),
    truncated: all.length > MAX_FAULTS_PER_ALERT,
  };
}

/** Nothing new happened, and an email saying so is how a channel dies. */
export function isWorthSending(summary: NewFaultSummary): boolean {
  return summary.faults.length > 0;
}

function alertable(group: FaultGroup, origin: FaultOrigin): AlertableFault {
  return {
    fingerprint: group.fingerprint,
    type: group.type,
    occurrences: group.occurrences,
    where: group.where,
    origin,
  };
}
