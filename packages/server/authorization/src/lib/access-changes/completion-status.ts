import type { OwnerLockLease } from "@dads-framework/access/runtime";

export type UnfinishedAccessChange = {
  readonly idempotencyKey: string;
  readonly ownerPartitionId: string;
  readonly status: "PENDING" | "FAILED";
};

/** Reads unfinished facts only within the caller's explicit owner partitions. */
export abstract class AccessChangeCompletionStatusReader {
  abstract readUnfinished(input: {
    readonly ownerPartitionIds: readonly string[];
  }): Promise<readonly UnfinishedAccessChange[]>;
}

/** Explicitly reopens named exhausted facts under their owner's live lease. */
export abstract class RetryFailedAccessChanges {
  abstract retryFailed(input: {
    readonly ownerPartitionId: string;
    readonly idempotencyKeys: readonly string[];
    readonly lease: OwnerLockLease;
  }): Promise<void>;
}
