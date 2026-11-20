import {
  EnqueueAccessChanges,
  type AccessChange,
  type OutboxTx,
} from "../lib/access-changes/enqueue.js";
import type { OwnerLockLease } from "@dads-framework/access/runtime";

/**
 * In-memory outbox for unit tests, mirroring FakeLiveEnvironmentActionRunWriter. The enqueued
 * entries are readable as an array so a mutation test can assert the exact
 * authorization intent it produced without a database.
 *
 * The `tx` argument is accepted and ignored: a fake has no transaction, and
 * pretending otherwise would test the fake rather than the mutation. What the
 * transaction actually buys — the row and the entry committing together — is
 * proved once, against a real Postgres, in the adapter's integration test.
 *
 * Deduplicates on `idempotencyKey` exactly as the unique index does, so a test
 * that enqueues the same fact twice sees what production would see.
 */
export class FakeEnqueueAccessChanges extends EnqueueAccessChanges {
  private readonly entries: AccessChange[] = [];

  /**
   * Fails when set, so a test can prove that a durable-record failure DOES
   * fail the caller — the opposite of the synchronous graph delete, which is
   * swallowed (`revokeAccess`).
   */
  failNext = false;

  append(newEntries: readonly AccessChange[]): Promise<void> {
    return this.enqueue(newEntries);
  }

  enqueue(newEntries: readonly AccessChange[]): Promise<void> {
    if (this.failNext) {
      return Promise.reject(new Error("outbox unavailable"));
    }
    for (const entry of newEntries) {
      const known = this.entries.some(
        (existing) => existing.idempotencyKey === entry.idempotencyKey,
      );
      if (!known) this.entries.push(entry);
    }
    return Promise.resolve();
  }

  enqueueReplacingOpposite(
    newEntries: readonly AccessChange[],
    _tx: OutboxTx,
    lease: OwnerLockLease,
  ): Promise<void> {
    return this.replaceOpposite(newEntries, lease);
  }

  /**
   * The same replacement without a transaction handle, for a fake store that
   * stands in for the row transaction. Rejects before touching anything when
   * `failNext` is set, so a failed "transaction" leaves the outbox unchanged.
   */
  replaceOpposite(
    newEntries: readonly AccessChange[],
    lease: OwnerLockLease,
  ): Promise<void> {
    if (this.failNext) {
      return Promise.reject(new Error("outbox unavailable"));
    }
    for (const entry of newEntries) {
      if (entry.ownerPartitionId === null) {
        return Promise.reject(
          new Error("replacement facts require an owner partition"),
        );
      }
      lease.assertPartition(entry.ownerPartitionId);
    }
    for (const entry of newEntries) {
      for (let index = this.entries.length - 1; index >= 0; index -= 1) {
        const existing = this.entries[index];
        if (
          existing !== undefined &&
          existing.operation !== entry.operation &&
          sameExactFact(existing, entry)
        ) {
          this.entries.splice(index, 1);
        }
      }
    }
    return this.enqueue(newEntries);
  }

  /** Everything enqueued so far, in order. */
  get enqueued(): readonly AccessChange[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries.length = 0;
  }
}

function sameExactFact(left: AccessChange, right: AccessChange): boolean {
  const leftRelationship = left.relationship;
  const rightRelationship = right.relationship;
  return (
    left.ownerPartitionId === right.ownerPartitionId &&
    leftRelationship.resource.type === rightRelationship.resource.type &&
    leftRelationship.resource.id === rightRelationship.resource.id &&
    leftRelationship.relation === rightRelationship.relation &&
    leftRelationship.subject.type === rightRelationship.subject.type &&
    leftRelationship.subject.id === rightRelationship.subject.id &&
    leftRelationship.subject.relation === rightRelationship.subject.relation
  );
}
