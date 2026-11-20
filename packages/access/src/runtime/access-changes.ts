import type { RelationshipWrite } from "./authorization.js";
import type { OwnerLockLease } from "./owner-lock.js";

export const OUTBOX_OPERATION_VALUES = ["WRITE", "DELETE"] as const;

export type OutboxOperation = (typeof OUTBOX_OPERATION_VALUES)[number];

/**
 * One authorization fact awaiting projection.
 *
 * `idempotencyKey` is what makes at-least-once delivery safe: the same fact
 * enqueued twice is one row, so a retried transaction cannot double-project.
 * Callers derive it from the change they are recording (see
 * `outboxKeyForRelationship`), never from a random value — a random key would
 * make every retry a new fact.
 *
 * `ownerPartitionId` is the UUID of the exact authority slice this fact
 * belongs to. The application chooses the partition key. The projector and lifecycle revocations
 * coordinate on it so an older opposite fact cannot be applied after its
 * replacement.
 */
export type AccessChange = {
  readonly idempotencyKey: string;
  readonly operation: OutboxOperation;
  readonly relationship: RelationshipWrite;
  readonly ownerPartitionId: string | null;
};

/**
 * Implemented by PostgresEnqueueAccessChanges; FakeEnqueueAccessChanges in unit
 * tests.
 */
export abstract class EnqueueAccessChanges<Tx> {
  /**
   * Append entries inside the caller's transaction. Re-enqueuing an entry
   * whose `idempotencyKey` is already present is a no-op, not a conflict:
   * recording the same fact twice must never fail the state change that
   * caused it.
   */
  abstract enqueue(entries: readonly AccessChange[], tx: Tx): Promise<void>;

  /**
   * Task-specific replacement ordering for a caller that proves one active
   * provenance source per exact relationship. This terminally supersedes an
   * older exact PENDING/FAILED fact with the opposite operation, records when
   * and which idempotency key superseded it, and enqueues the replacement in
   * the same transaction. SUPERSEDED is terminal but non-error, so lastError
   * stays null. Every entry must name a non-null owner partition; other domains
   * and ordinary facts must use enqueue.
   */
  abstract enqueueReplacingOpposite(
    entries: readonly AccessChange[],
    tx: Tx,
    lease: OwnerLockLease,
  ): Promise<void>;

  /**
   * Append entries that have NO row of their own, supplying the handle
   * internally so a caller still never holds one.
   *
   * This is not a convenience alternative to `enqueue` and must not be used
   * where a state change exists: the whole value of `enqueue` is that the row
   * and its fact cannot disagree, and reaching for `append` beside an insert
   * throws that away silently. It exists for revocations that cannot enqueue
   * through an owning row transaction; `revokeAccess` supplies the internal
   * handle and still applies the relationship removal synchronously.
   */
  abstract append(entries: readonly AccessChange[]): Promise<void>;
}

/**
 * The WRITE facts a creating mutation hands to its writer.
 *
 * The caller states its ownership tuples as data, and the writer commits them in
 * the same transaction as the insert — replacing the older sequential
 * `writeRelationships` call, which could be interrupted between the row and
 * the fact and leave a resource nobody could reach.
 *
 * `cause` is the id of the row being created, which is why creates mint their
 * id in the mutation: the fact has to name the resource before the insert
 * happens.
 */
export function accessChangesToWrite(
  relationships: readonly RelationshipWrite[],
  cause: string,
  ownerPartitionId: string | null,
): AccessChange[] {
  return relationships.map((relationship) => ({
    idempotencyKey: outboxKeyForRelationship("WRITE", relationship, cause),
    operation: "WRITE",
    relationship,
    ownerPartitionId,
  }));
}

/**
 * The canonical idempotency key for a relationship change: stable across
 * retries of the same logical change, distinct for every different one.
 *
 * `cause` is what makes it stable rather than merely unique — normally the id
 * of the state change being recorded (the created row, the ended session). Two
 * different causes writing the same tuple are two facts and must both be
 * enqueued; one cause retried is one fact.
 *
 * **The exception is a revocation whose row is reused or absent.** A
 * membership row moves add → remove → add → remove, while a
 * relationship-only revocation has no spent row at all. A derived key would
 * make a later removal collide with the first and never be projected — which
 * is lingering access. Those sites mint a fresh cause on purpose. For a DELETE
 * the failure directions are not symmetric: a duplicate is a no-op in SpiceDB,
 * a suppressed one is a security hole. See
 * `docs/architecture/authorization.md#choosing-a-facts-cause`.
 */
export function outboxKeyForRelationship(
  operation: OutboxOperation,
  relationship: RelationshipWrite,
  cause: string,
): string {
  const { resource, relation, subject } = relationship;
  const subjectRelation = subject.relation ? `#${subject.relation}` : "";
  return [
    operation,
    `${resource.type}:${resource.id}`,
    relation,
    `${subject.type}:${subject.id}${subjectRelation}`,
    cause,
  ].join("|");
}
