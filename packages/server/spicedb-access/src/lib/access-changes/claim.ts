import type { AccessChangeId } from "./access-change.ids.js";
import type { authorizationOutbox } from "./postgres/access-changes.tables.js";

/**
 * The projector's side of the outbox: claim work, report what happened.
 *
 * Separate from `EnqueueAccessChanges` on purpose. Producers only ever append,
 * inside someone else's transaction; the projector only ever claims and
 * settles, in its own. Keeping them apart means a domain writer cannot reach a
 * method that marks facts projected, and the projector cannot enqueue.
 */

/** One claimed fact, flattened out of storage and ready to apply. */
export type ClaimedOutboxRow = Readonly<
  Pick<
    typeof authorizationOutbox.$inferSelect,
    | "id"
    | "idempotencyKey"
    | "operation"
    | "resourceType"
    | "resourceId"
    | "relation"
    | "subjectType"
    | "subjectId"
    | "subjectRelation"
    | "ownerPartitionId"
    | "attempts"
  >
>;

export type OutboxClaim = {
  readonly batchSize: number;
  readonly workerId: string;
  readonly now: Date;
  /** Rows locked at or before this instant are stealable (a dead worker's). */
  readonly leaseCutoff: Date;
};

/**
 * A claim narrowed to facts the caller already knows the keys of — the
 * immediate dispatch that runs right after a create commits.
 *
 * Scoped rather than a general drain on purpose: a request must project the
 * facts IT caused and nothing else. A full-queue drain inside a request would
 * make one user's create latency depend on the size of everybody's backlog,
 * and would let a poison row anywhere in the queue take the request down with
 * it. Same lease rules, same exclusion, narrower window.
 */
export type OutboxKeyClaim = {
  readonly idempotencyKeys: readonly string[];
  readonly workerId: string;
  readonly now: Date;
  readonly leaseCutoff: Date;
};

/**
 * Named facts to look up without claiming them: which are still PENDING under
 * a live lease (locked after `leaseCutoff`), so another worker is projecting
 * them right now.
 */
export type OutboxHeldKeysQuery = {
  readonly idempotencyKeys: readonly string[];
  readonly leaseCutoff: Date;
};

export type OutboxCounts = {
  readonly pending: number;
  readonly failed: number;
};

export abstract class ClaimAccessChanges {
  /**
   * Take up to `batchSize` rows, stamping them with this worker. Must be
   * atomic per row — two workers running at once may never receive the same
   * fact — which is why the adapter claims with `FOR UPDATE SKIP LOCKED` and
   * this seam offers no read-then-write alternative.
   */
  abstract claim(claim: OutboxClaim): Promise<readonly ClaimedOutboxRow[]>;
  /**
   * The same atomic take, restricted to named facts. A key whose row is
   * already PROJECTED, or is held by a live worker, is simply not returned —
   * so a dispatch that races the background projector does nothing rather
   * than projecting twice.
   */
  abstract claimByKeys(
    claim: OutboxKeyClaim,
  ): Promise<readonly ClaimedOutboxRow[]>;
  /**
   * Of the named facts, the keys still PENDING and held under a live lease by
   * any worker. A read only: it claims nothing, takes no row lock and never
   * waits, so a caller can watch another worker's claim without stealing it.
   */
  abstract heldByLiveClaim(
    query: OutboxHeldKeysQuery,
  ): Promise<readonly string[]>;
  abstract isClaimOwned(id: AccessChangeId, workerId: string): Promise<boolean>;
  abstract markProjected(
    ids: readonly AccessChangeId[],
    at: Date,
    workerId: string,
  ): Promise<boolean>;
  abstract markFailed(
    id: AccessChangeId,
    outcome: {
      readonly status: "PENDING" | "FAILED";
      readonly attempts: number;
    },
    lastError: string,
    workerId: string,
  ): Promise<boolean>;
  /** What the reconcile operation reports: is the projector telling the truth? */
  abstract counts(): Promise<OutboxCounts>;
}
