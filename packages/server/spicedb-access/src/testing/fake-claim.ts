import { deterministicUuid } from "@dads-framework/postgres/testing/deterministic-uuid";

import { accessChangeIdSchema, type AccessChangeId } from "../lib/access-changes/access-change.ids.js";
import {
  ClaimAccessChanges,
  type ClaimedOutboxRow,
  type OutboxClaim,
  type OutboxCounts,
  type OutboxHeldKeysQuery,
  type OutboxKeyClaim,
} from "../lib/access-changes/claim.js";
import type { AccessChange, OutboxStatus } from "../lib/access-changes/enqueue.js";

type StoredRow = Omit<ClaimedOutboxRow, "attempts"> & {
  attempts: number;
  status: OutboxStatus;
  lockedBy: string | null;
  lockedAt: Date | null;
  lastError: string | null;
};

/**
 * A stable `AccessChangeId` for a human-readable test label ("r1"), so a
 * suite can seed a row by name and reference the SAME row later without
 * inventing a real UUID by hand.
 */
export function testAccessChangeId(label: string): AccessChangeId {
  return accessChangeIdSchema.parse(deterministicUuid(label, 0));
}

/**
 * In-memory projector store for unit tests. It reproduces the ONE behaviour
 * the projector's correctness depends on — which rows a claim may take: PENDING
 * rows that are either unlocked or whose lock is older than the cutoff the
 * caller passed. Real exclusion between concurrent workers is a database
 * guarantee (`FOR UPDATE SKIP LOCKED`) and is proved against Postgres, not
 * imitated here.
 */
export class FakeClaimAccessChanges extends ClaimAccessChanges {
  private readonly rows = new Map<AccessChangeId, StoredRow>();
  private lastCutoff: Date | null = null;

  seed(...rows: readonly ClaimedOutboxRow[]): void {
    for (const row of rows) {
      this.rows.set(row.id, {
        ...row,
        status: "PENDING",
        lockedBy: null,
        lockedAt: null,
        lastError: null,
      });
    }
  }

  /**
   * Seed from PRODUCER-side entries — what a writer just committed — flattened
   * the way the table holds them. This is how a domain test replays the facts
   * its own create enqueued, without hand-building storage rows.
   */
  seedEntries(...entries: readonly AccessChange[]): void {
    for (const [index, entry] of entries.entries()) {
      const { resource, relation, subject } = entry.relationship;
      this.seed({
        id: testAccessChangeId(`seeded-${index}-${entry.idempotencyKey}`),
        idempotencyKey: entry.idempotencyKey,
        operation: entry.operation,
        resourceType: resource.type,
        resourceId: resource.id,
        relation,
        subjectType: subject.type,
        subjectId: subject.id,
        subjectRelation: subject.relation ?? null,
        ownerPartitionId: entry.ownerPartitionId,
        attempts: 0,
      });
    }
  }

  /** Put a row back the way an expired lease or a retry would. */
  rePend(id: AccessChangeId): void {
    const row = this.rows.get(id);
    if (!row) throw new Error(`No such row ${id}`);
    row.status = "PENDING";
    row.lockedBy = null;
    row.lockedAt = null;
  }

  /** Stamp a row as held, to fabricate a live or a crashed worker's claim. */
  claimBy(id: AccessChangeId, workerId: string, at: Date): void {
    const row = this.rows.get(id);
    if (!row) throw new Error(`No such row ${id}`);
    row.lockedBy = workerId;
    row.lockedAt = at;
  }

  statusOf(id: AccessChangeId): OutboxStatus | undefined {
    return this.rows.get(id)?.status;
  }

  attemptsOf(id: AccessChangeId): number | undefined {
    return this.rows.get(id)?.attempts;
  }

  errorOf(id: AccessChangeId): string | null | undefined {
    return this.rows.get(id)?.lastError;
  }

  lockedByOf(id: AccessChangeId): string | null | undefined {
    return this.rows.get(id)?.lockedBy;
  }

  /** The cutoff the projector asked for — proof it applied its lease. */
  lastClaimCutoff(): Date | null {
    return this.lastCutoff;
  }

  claim(claim: OutboxClaim): Promise<readonly ClaimedOutboxRow[]> {
    this.lastCutoff = claim.leaseCutoff;
    return Promise.resolve(this.take(claim, () => true, claim.batchSize));
  }

  claimByKeys(claim: OutboxKeyClaim): Promise<readonly ClaimedOutboxRow[]> {
    this.lastCutoff = claim.leaseCutoff;
    const wanted = new Set(claim.idempotencyKeys);
    return Promise.resolve(this.take(claim, (row) => wanted.has(row.idempotencyKey), Infinity));
  }

  private take(
    claim: { workerId: string; now: Date; leaseCutoff: Date },
    wanted: (row: StoredRow) => boolean,
    batchSize: number,
  ): ClaimedOutboxRow[] {
    const taken: ClaimedOutboxRow[] = [];
    for (const row of this.rows.values()) {
      if (taken.length >= batchSize) break;
      if (row.status !== "PENDING") continue;
      if (!wanted(row)) continue;
      const free = row.lockedAt === null || row.lockedAt.getTime() <= claim.leaseCutoff.getTime();
      if (!free) continue;
      row.lockedBy = claim.workerId;
      row.lockedAt = claim.now;
      taken.push({
        id: row.id,
        idempotencyKey: row.idempotencyKey,
        operation: row.operation,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        relation: row.relation,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        subjectRelation: row.subjectRelation,
        ownerPartitionId: row.ownerPartitionId,
        attempts: row.attempts,
      });
    }
    return taken;
  }

  heldByLiveClaim(query: OutboxHeldKeysQuery): Promise<readonly string[]> {
    const wanted = new Set(query.idempotencyKeys);
    const held: string[] = [];
    for (const row of this.rows.values()) {
      if (row.status !== "PENDING" || !wanted.has(row.idempotencyKey)) continue;
      if (row.lockedAt === null) continue;
      if (row.lockedAt.getTime() <= query.leaseCutoff.getTime()) continue;
      held.push(row.idempotencyKey);
    }
    return Promise.resolve(held);
  }

  isClaimOwned(id: AccessChangeId, workerId: string): Promise<boolean> {
    const row = this.rows.get(id);
    return Promise.resolve(row?.status === "PENDING" && row.lockedBy === workerId);
  }

  markProjected(ids: readonly AccessChangeId[], at: Date, workerId: string): Promise<boolean> {
    let settled = 0;
    for (const id of ids) {
      const row = this.rows.get(id);
      if (row?.status !== "PENDING" || row.lockedBy !== workerId) {
        continue;
      }
      row.status = "PROJECTED";
      row.lockedBy = null;
      row.lockedAt = null;
      row.lastError = null;
      settled += 1;
      void at;
    }
    return Promise.resolve(settled === ids.length);
  }

  markFailed(
    id: AccessChangeId,
    outcome: { status: "PENDING" | "FAILED"; attempts: number },
    lastError: string,
    workerId: string,
  ): Promise<boolean> {
    const row = this.rows.get(id);
    if (row?.status === "PENDING" && row.lockedBy === workerId) {
      row.status = outcome.status;
      row.attempts = outcome.attempts;
      row.lastError = lastError;
      row.lockedBy = null;
      row.lockedAt = null;
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  counts(): Promise<OutboxCounts> {
    let pending = 0;
    let failed = 0;
    for (const row of this.rows.values()) {
      if (row.status === "PENDING") pending += 1;
      if (row.status === "FAILED") failed += 1;
    }
    return Promise.resolve({ pending, failed });
  }
}
