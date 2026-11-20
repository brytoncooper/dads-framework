/**
 * No behavior lives in this file. The port the fault-alert job holds, and the
 * injection token composition binds. `DrizzleFaultAlertReader` implements it;
 * a fake stands in for the job's unit tests, which is what lets the "what is
 * worth waking someone for" rules be proved without a database.
 *
 * The port reads faults AND remembers which ones have been alerted, because
 * those are one decision: "new" is defined by the memory, and a port that
 * could read without remembering would let a caller alert twice.
 */

/** Which fault table a fingerprint came from. Part of its identity. */
export type FaultOrigin = "server" | "client";

/** One fault type, as the alert needs to describe it. */
export type FaultGroup = {
  /** The stable grouping key — the thing that makes this ONE fault, not many. */
  readonly fingerprint: string;
  /** The exception class, or the client fault kind. */
  readonly type: string;
  /** How many times it happened inside the window being swept. */
  readonly occurrences: number;
  /** Where it happened — a route pattern, or a client release. */
  readonly where: string | null;
};

/** A fault type the alert has now told somebody about. */
export type AlertedFault = {
  readonly origin: FaultOrigin;
  readonly fingerprint: string;
};

export abstract class FaultAlertReader {
  /**
   * Server faults that happened at or after `since` and have never been
   * alerted on.
   *
   * "Never been alerted" is a fact in `known_fault_fingerprints`, not an
   * inference from the fault tables. Those are pruned — 90 days for
   * `request_log`, 30 for client diagnostics — so a fault that goes quiet for
   * a month and comes back has no old rows left to prove it is not new.
   * Asking the memory instead is what makes "new" survive retention, and it
   * is also what makes the sweep idempotent: the window can be any length
   * without a fingerprint being reported twice.
   */
  abstract unalertedServerFaultsSince(
    since: Date,
  ): Promise<readonly FaultGroup[]>;

  /** Client faults since `since` that have never been alerted on. */
  abstract unalertedClientFaultsSince(
    since: Date,
  ): Promise<readonly FaultGroup[]>;

  /**
   * Whether anything has ever been remembered.
   *
   * False means alerting has never run here, and every fault still on record
   * would read as new — see `rememberFaultsSeenBefore`.
   */
  abstract hasRememberedAnyFault(): Promise<boolean>;

  /**
   * Remember every fault type that was already happening before `before`,
   * alerting on none of them, and answer how many were recorded.
   *
   * Runs while the memory is empty. Without it, switching alerting on would
   * report months of known problems in one email — the exact thing that
   * teaches people to filter the channel on day one. It deliberately does
   * *not* swallow faults that only started inside the window: on a system
   * where nothing has broken yet this records nothing, and the first fault to
   * ever happen still gets an alert.
   */
  abstract rememberFaultsSeenBefore(before: Date): Promise<number>;

  /**
   * Remember the faults an alert just went out about.
   *
   * Called after the mail is enqueued, never before: an alert that is
   * remembered and then not sent is one nobody ever hears about, while the
   * reverse costs a duplicate email on a retry.
   */
  abstract rememberAlertedFaults(
    faults: readonly AlertedFault[],
  ): Promise<void>;
}
