import { and, count, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";

import type { DrizzleHandle } from "@dads-framework/postgres";

import type { AccessChangeId } from "../access-change.ids.js";
import type { ClaimAccessChanges } from "../claim.js";
import {
  type ClaimedOutboxRow,
  type OutboxClaim,
  type OutboxCounts,
  type OutboxHeldKeysQuery,
  type OutboxKeyClaim,
} from "../claim.js";
import { authorizationOutbox } from "./access-changes.tables.js";

/** PENDING, and either unlocked or holding a lock old enough to steal. */
function claimable(leaseCutoff: Date) {
  return and(
    eq(authorizationOutbox.status, "PENDING"),
    or(
      isNull(authorizationOutbox.lockedAt),
      lte(authorizationOutbox.lockedAt, leaseCutoff),
    ),
  );
}

/**
 * Postgres adapter for the projector's side of the outbox.
 *
 * The claim is one statement: an UPDATE whose subquery selects with
 * `FOR UPDATE SKIP LOCKED`. Two workers running at once therefore never
 * receive the same row — the second skips what the first has locked instead of
 * waiting for it — and no read-then-write window exists in which both could
 * decide a row was theirs.
 *
 * The claim takes PENDING rows AND rows whose lease has expired. The second
 * half is what stops a crashed worker parking a fact forever: its lock is
 * stale, so the row comes back rather than sitting claimed by a process that
 * no longer exists.
 */
export class PostgresClaimAccessChanges implements ClaimAccessChanges {
  constructor(private readonly db: DrizzleHandle) {}

  async claim(claim: OutboxClaim): Promise<readonly ClaimedOutboxRow[]> {
    return this.take(
      claimable(claim.leaseCutoff),
      claim.batchSize,
      claim.workerId,
      claim.now,
    );
  }

  async claimByKeys(
    claim: OutboxKeyClaim,
  ): Promise<readonly ClaimedOutboxRow[]> {
    if (claim.idempotencyKeys.length === 0) return [];
    return this.take(
      and(
        claimable(claim.leaseCutoff),
        inArray(authorizationOutbox.idempotencyKey, [...claim.idempotencyKeys]),
      ),
      claim.idempotencyKeys.length,
      claim.workerId,
      claim.now,
    );
  }

  /**
   * The claim both entry points share, so the exclusion rules cannot drift
   * apart: select eligible rows `FOR UPDATE SKIP LOCKED`, then stamp them in
   * the same statement.
   */
  private async take(
    where: ReturnType<typeof claimable>,
    batchSize: number,
    workerId: string,
    now: Date,
  ): Promise<readonly ClaimedOutboxRow[]> {
    const eligible = this.db
      .select({ id: authorizationOutbox.id })
      .from(authorizationOutbox)
      .where(where)
      .orderBy(authorizationOutbox.enqueuedAt)
      .limit(batchSize)
      .for("update", { skipLocked: true });

    return this.db
      .update(authorizationOutbox)
      .set({ lockedBy: workerId, lockedAt: now })
      .where(inArray(authorizationOutbox.id, eligible))
      .returning({
        id: authorizationOutbox.id,
        idempotencyKey: authorizationOutbox.idempotencyKey,
        operation: authorizationOutbox.operation,
        resourceType: authorizationOutbox.resourceType,
        resourceId: authorizationOutbox.resourceId,
        relation: authorizationOutbox.relation,
        subjectType: authorizationOutbox.subjectType,
        subjectId: authorizationOutbox.subjectId,
        subjectRelation: authorizationOutbox.subjectRelation,
        ownerPartitionId: authorizationOutbox.ownerPartitionId,
        attempts: authorizationOutbox.attempts,
      });
  }

  /**
   * One read on the idempotency-key unique index: no `FOR UPDATE`, so it
   * never waits on, nor takes, another worker's claim.
   */
  async heldByLiveClaim(
    query: OutboxHeldKeysQuery,
  ): Promise<readonly string[]> {
    if (query.idempotencyKeys.length === 0) return [];
    const rows = await this.db
      .select({ idempotencyKey: authorizationOutbox.idempotencyKey })
      .from(authorizationOutbox)
      .where(
        and(
          inArray(authorizationOutbox.idempotencyKey, [
            ...query.idempotencyKeys,
          ]),
          eq(authorizationOutbox.status, "PENDING"),
          gt(authorizationOutbox.lockedAt, query.leaseCutoff),
        ),
      );
    return rows.map((row) => row.idempotencyKey);
  }

  async isClaimOwned(id: AccessChangeId, workerId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: authorizationOutbox.id })
      .from(authorizationOutbox)
      .where(
        and(
          eq(authorizationOutbox.id, id),
          eq(authorizationOutbox.status, "PENDING"),
          eq(authorizationOutbox.lockedBy, workerId),
        ),
      )
      .limit(1);
    return rows[0] !== undefined;
  }

  async markProjected(
    ids: readonly AccessChangeId[],
    at: Date,
    workerId: string,
  ): Promise<boolean> {
    if (ids.length === 0) return false;
    const settled = await this.db
      .update(authorizationOutbox)
      .set({
        status: "PROJECTED",
        projectedAt: at,
        lockedBy: null,
        lockedAt: null,
        lastError: null,
      })
      .where(
        and(
          inArray(authorizationOutbox.id, [...ids]),
          eq(authorizationOutbox.status, "PENDING"),
          eq(authorizationOutbox.lockedBy, workerId),
        ),
      )
      .returning({ id: authorizationOutbox.id });
    return settled.length === ids.length;
  }

  async markFailed(
    id: AccessChangeId,
    outcome: { status: "PENDING" | "FAILED"; attempts: number },
    lastError: string,
    workerId: string,
  ): Promise<boolean> {
    const settled = await this.db
      .update(authorizationOutbox)
      .set({
        status: outcome.status,
        attempts: outcome.attempts,
        lastError,
        // The lock is released either way: a PENDING row must be claimable by
        // the next run, and a FAILED row must not look like work in progress.
        lockedBy: null,
        lockedAt: null,
      })
      .where(
        and(
          eq(authorizationOutbox.id, id),
          eq(authorizationOutbox.status, "PENDING"),
          eq(authorizationOutbox.lockedBy, workerId),
        ),
      )
      .returning({ id: authorizationOutbox.id });
    return settled.length === 1;
  }

  async counts(): Promise<OutboxCounts> {
    const rows = await this.db
      .select({
        status: authorizationOutbox.status,
        total: count(),
      })
      .from(authorizationOutbox)
      .where(
        or(
          eq(authorizationOutbox.status, "PENDING"),
          eq(authorizationOutbox.status, "FAILED"),
        ),
      )
      .groupBy(authorizationOutbox.status);
    const of = (status: string): number =>
      rows.find((row) => row.status === status)?.total ?? 0;
    return { pending: of("PENDING"), failed: of("FAILED") };
  }
}
