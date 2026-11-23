import { and, eq, inArray, isNull } from "drizzle-orm";

import type { DrizzleHandle } from "@dads-framework/postgres";
import { mintEntityId } from "@dads-framework/core/contract";

import { accessChangeIdSchema } from "../access-change.ids.js";
import type { EnqueueAccessChanges } from "../enqueue.js";
import { type AccessChange, type OutboxTx } from "../enqueue.js";
import type { OwnerLockLease } from "@dads-framework/access/runtime";
import { authorizationOutbox } from "./access-changes.tables.js";

/**
 * Postgres adapter for the outbox seam. Ordinary producers only insert. The
 * explicit replacement path is the single exception: a single-source
 * lifecycle writer holding the matching partition lease may terminally
 * supersede older exact opposite facts in the same transaction that records
 * their replacement facts.
 *
 * `onConflictDoNothing` on `idempotency_key` is deliberate and load-bearing: a
 * retried transaction re-enqueuing the same fact must be a no-op rather than a
 * unique-violation that fails the state change it was recording. The key is
 * derived from the cause (see `outboxKeyForRelationship`), so "the same fact"
 * means the same logical change, not merely the same tuple.
 */
export class PostgresEnqueueAccessChanges implements EnqueueAccessChanges {
  constructor(private readonly db: DrizzleHandle) {}

  /**
   * The handle a fact with no row of its own uses. One multi-row insert is
   * already atomic, so this needs no explicit transaction — and the database
   * stays here in the adapter, which is the point.
   */
  async append(entries: readonly AccessChange[]): Promise<void> {
    await this.enqueue(entries, this.db);
  }

  async enqueue(entries: readonly AccessChange[], tx: OutboxTx): Promise<void> {
    if (entries.length === 0) return;
    const enqueuedAt = new Date();
    await tx
      .insert(authorizationOutbox)
      .values(
        entries.map((entry) => ({
          id: mintEntityId(accessChangeIdSchema),
          idempotencyKey: entry.idempotencyKey,
          operation: entry.operation,
          resourceType: entry.relationship.resource.type,
          resourceId: entry.relationship.resource.id,
          relation: entry.relationship.relation,
          subjectType: entry.relationship.subject.type,
          subjectId: entry.relationship.subject.id,
          subjectRelation: entry.relationship.subject.relation ?? null,
          ownerPartitionId: entry.ownerPartitionId,
          status: "PENDING" as const,
          enqueuedAt,
        })),
      )
      .onConflictDoNothing({
        target: authorizationOutbox.idempotencyKey,
      });
  }

  async enqueueReplacingOpposite(entries: readonly AccessChange[], tx: OutboxTx, lease: OwnerLockLease): Promise<void> {
    if (entries.length === 0) return;
    if (entries.some((entry) => entry.ownerPartitionId === null)) {
      throw new Error("replacement facts require an owner partition");
    }
    for (const entry of entries) {
      lease.assertPartition(requireOwnerPartition(entry));
    }
    const supersededAt = new Date();
    for (const entry of entries) {
      const { resource, relation, subject } = entry.relationship;
      const ownerPartitionId = requireOwnerPartition(entry);
      await tx
        .update(authorizationOutbox)
        .set({
          status: "SUPERSEDED",
          lockedBy: null,
          lockedAt: null,
          lastError: null,
          supersededAt,
          supersededByIdempotencyKey: entry.idempotencyKey,
        })
        .where(
          and(
            eq(authorizationOutbox.operation, entry.operation === "WRITE" ? "DELETE" : "WRITE"),
            eq(authorizationOutbox.resourceType, resource.type),
            eq(authorizationOutbox.resourceId, resource.id),
            eq(authorizationOutbox.relation, relation),
            eq(authorizationOutbox.subjectType, subject.type),
            eq(authorizationOutbox.subjectId, subject.id),
            subject.relation === undefined
              ? isNull(authorizationOutbox.subjectRelation)
              : eq(authorizationOutbox.subjectRelation, subject.relation),
            eq(authorizationOutbox.ownerPartitionId, ownerPartitionId),
            inArray(authorizationOutbox.status, ["PENDING", "FAILED"]),
          ),
        );
    }
    await this.enqueue(entries, tx);
  }
}

function requireOwnerPartition(entry: AccessChange): string {
  if (entry.ownerPartitionId === null) {
    throw new Error("replacement facts require an owner partition");
  }
  return entry.ownerPartitionId;
}
