import { ok, type Result } from "@dads-framework/errors";

import type {
  Authorization,
  RelationshipWrite,
} from "@dads-framework/access/runtime";
import type { ClaimAccessChanges } from "./claim.js";
import { type ClaimedOutboxRow } from "./claim.js";
import {
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  leaseCutoff,
  outcomeAfterFailure,
  summarizeError,
} from "./logic/claim-rules.js";
import type { OwnerLock } from "@dads-framework/access/runtime";

export type ApplyAccessChangesReport = {
  readonly claimed: number;
  readonly projected: number;
  readonly failed: number;
};

export type ApplyAccessChangesInput = {
  readonly batchSize?: number;
  readonly workerId: string;
};

/**
 * Carries claimed facts from Postgres into SpiceDB — the outbox's only reader,
 * and the reason a producer never has to call the graph itself.
 *
 * **Idempotency is the contract here, not a hope.** Delivery is at-least-once
 * by design: a crashed worker's lease expires and its rows come back, so the
 * same batch can be applied twice. That is safe because both operations are
 * naturally idempotent — SpiceDB's relationship write uses TOUCH semantics, so
 * writing an existing tuple changes nothing, and deleting an absent tuple is a
 * no-op. The projector therefore never needs to ask what it already did.
 *
 * Each row settles on its own. One fact that cannot be projected must not
 * strand the rest of the batch, because the rest are somebody's access.
 */
export class ApplyAccessChanges {
  constructor(
    private readonly store: ClaimAccessChanges,
    private readonly authorization: Authorization,
    private readonly now: () => Date,
    private readonly coordinator: OwnerLock,
    private readonly leaseMs: number = DEFAULT_LEASE_MS,
    private readonly maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
  ) {}

  async execute(
    input: ApplyAccessChangesInput,
  ): Promise<Result<ApplyAccessChangesReport>> {
    const at = this.now();
    const claimed = await this.store.claim({
      batchSize: input.batchSize ?? 50,
      workerId: input.workerId,
      now: at,
      leaseCutoff: leaseCutoff(at, this.leaseMs),
    });
    return this.settle(claimed, input.workerId);
  }

  /**
   * Project exactly the named facts — the immediate dispatch a create runs
   * once its transaction has committed.
   *
   * It is the same claim/apply/settle path as `execute`, narrowed by key, so
   * the producer still never touches claim or settle itself. A key already
   * projected, or held by a live worker, is not claimed and therefore not
   * re-applied.
   */
  async applyKeys(input: {
    readonly idempotencyKeys: readonly string[];
    readonly workerId: string;
  }): Promise<Result<ApplyAccessChangesReport>> {
    const at = this.now();
    const claimed = await this.store.claimByKeys({
      idempotencyKeys: input.idempotencyKeys,
      workerId: input.workerId,
      now: at,
      leaseCutoff: leaseCutoff(at, this.leaseMs),
    });
    return this.settle(claimed, input.workerId);
  }

  /**
   * Of the named facts, the ones another worker is projecting right now:
   * still PENDING under a live lease. It claims nothing, so a caller waiting
   * on its own facts never takes them from the worker that holds them.
   */
  async keysHeldByLiveClaims(
    idempotencyKeys: readonly string[],
  ): Promise<readonly string[]> {
    return this.store.heldByLiveClaim({
      idempotencyKeys,
      leaseCutoff: leaseCutoff(this.now(), this.leaseMs),
    });
  }

  private async settle(
    claimed: readonly ClaimedOutboxRow[],
    workerId: string,
  ): Promise<Result<ApplyAccessChangesReport>> {
    let projected = 0;
    let failed = 0;
    for (const row of claimed) {
      const settleRow = async () => {
        const owned = await this.store.isClaimOwned(row.id, workerId);
        if (!owned) return "SUPERSEDED";
        const applied = await this.apply(row, workerId);
        if (applied === "APPLIED") {
          const settled = await this.store.markProjected(
            [row.id],
            this.now(),
            workerId,
          );
          return settled ? "PROJECTED" : "OWNERSHIP_LOST";
        }
        return applied;
      };
      const outcome =
        row.ownerPartitionId === null
          ? await settleRow()
          : await this.coordinator.run(row.ownerPartitionId, settleRow);
      if (outcome === "PROJECTED") projected += 1;
      if (outcome === "FAILED") failed += 1;
    }

    return ok({ claimed: claimed.length, projected, failed });
  }

  /** True when the fact reached the graph; false when it was recorded failed. */
  private async apply(
    row: ClaimedOutboxRow,
    workerId: string,
  ): Promise<"APPLIED" | "FAILED" | "OWNERSHIP_LOST"> {
    try {
      if (row.operation === "WRITE") {
        await this.authorization.writeRelationships([toRelationship(row)]);
      } else {
        await this.authorization.deleteRelationships({
          resourceType: row.resourceType,
          resourceId: row.resourceId,
          relation: row.relation,
          subject: {
            type: row.subjectType,
            id: row.subjectId,
            ...(row.subjectRelation === null
              ? {}
              : { relation: row.subjectRelation }),
          },
        });
      }
      return "APPLIED";
    } catch (error) {
      const settled = await this.store.markFailed(
        row.id,
        outcomeAfterFailure(row.attempts, this.maxAttempts),
        summarizeError(error),
        workerId,
      );
      return settled ? "FAILED" : "OWNERSHIP_LOST";
    }
  }
}

function toRelationship(row: ClaimedOutboxRow): RelationshipWrite {
  return {
    resource: { type: row.resourceType, id: row.resourceId },
    relation: row.relation,
    subject: {
      type: row.subjectType,
      id: row.subjectId,
      ...(row.subjectRelation === null
        ? {}
        : { relation: row.subjectRelation }),
    },
  };
}
