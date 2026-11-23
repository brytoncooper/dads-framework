import { and, eq, inArray, isNull } from "drizzle-orm";

import type { DrizzleHandle } from "@dads-framework/postgres";

import type {
  AccessChangeCompletionStatusReader,
  RetryFailedAccessChanges,
  UnfinishedAccessChange,
} from "../completion-status.js";
import type { OwnerLockLease } from "@dads-framework/access/runtime";
import { authorizationOutbox } from "./access-changes.tables.js";

/** Scoped completion reads and explicit failed-fact retry; never settles facts. */
export class PostgresAccessChangeCompletionStatus
  implements AccessChangeCompletionStatusReader, RetryFailedAccessChanges
{
  constructor(private readonly db: DrizzleHandle) {}

  async readUnfinished(input: {
    readonly ownerPartitionIds: readonly string[];
  }): Promise<readonly UnfinishedAccessChange[]> {
    if (input.ownerPartitionIds.length === 0) return [];
    const rows = await this.db
      .select({
        idempotencyKey: authorizationOutbox.idempotencyKey,
        ownerPartitionId: authorizationOutbox.ownerPartitionId,
        status: authorizationOutbox.status,
      })
      .from(authorizationOutbox)
      .where(
        and(
          inArray(authorizationOutbox.ownerPartitionId, [...input.ownerPartitionIds]),
          inArray(authorizationOutbox.status, ["PENDING", "FAILED"]),
        ),
      )
      .orderBy(authorizationOutbox.enqueuedAt, authorizationOutbox.id);
    return rows.map((row) => {
      if (row.ownerPartitionId === null || (row.status !== "PENDING" && row.status !== "FAILED")) {
        throw new Error("Completion query returned a fact outside its scope");
      }
      return {
        ...row,
        ownerPartitionId: row.ownerPartitionId,
        status: row.status,
      };
    });
  }

  /**
   * The named resources that still have a PENDING fact, a write or delete
   * not yet projected to the graph, as `type:id`. A FAILED fact has stopped
   * retrying, so it does not count: a caller waiting on it would wait for
   * good. One query.
   */
  async pendingResources(
    resources: readonly { readonly type: string; readonly id: string }[],
  ): Promise<ReadonlySet<string>> {
    if (resources.length === 0) return new Set();
    const named = new Set(resources.map(resourceKey));
    const rows = await this.db
      .selectDistinct({
        type: authorizationOutbox.resourceType,
        id: authorizationOutbox.resourceId,
      })
      .from(authorizationOutbox)
      .where(
        and(
          eq(authorizationOutbox.status, "PENDING"),
          inArray(authorizationOutbox.resourceId, [...new Set(resources.map((resource) => resource.id))]),
        ),
      );
    return new Set(rows.map(resourceKey).filter((key) => named.has(key)));
  }

  async retryFailed(input: {
    readonly ownerPartitionId: string;
    readonly idempotencyKeys: readonly string[];
    readonly lease: OwnerLockLease;
  }): Promise<void> {
    input.lease.assertPartition(input.ownerPartitionId);
    if (input.idempotencyKeys.length === 0) return;
    await this.db
      .update(authorizationOutbox)
      .set({ status: "PENDING", attempts: 0, lastError: null })
      .where(
        and(
          eq(authorizationOutbox.ownerPartitionId, input.ownerPartitionId),
          inArray(authorizationOutbox.idempotencyKey, [...input.idempotencyKeys]),
          eq(authorizationOutbox.status, "FAILED"),
          isNull(authorizationOutbox.lockedBy),
          isNull(authorizationOutbox.lockedAt),
          isNull(authorizationOutbox.supersededAt),
          isNull(authorizationOutbox.supersededByIdempotencyKey),
        ),
      );
  }
}

function resourceKey(resource: { readonly type: string; readonly id: string }): string {
  return `${resource.type}:${resource.id}`;
}
