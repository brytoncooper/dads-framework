import { AsyncLocalStorage } from "node:async_hooks";

const AUTHORIZATION_PARTITION_LEASE_TOKEN = Symbol(
  "authorization-partition-lease",
);

type DeferredProjection = () => Promise<void>;

/**
 * The partitions the current call path already holds.
 *
 * Nested owner locks are forbidden.
 * Re-entering a partition is not contention that resolves — the lock lives on
 * a POOLED SESSION, and a Postgres advisory lock is re-entrant only within one
 * session, so a caller that re-enters is waiting for itself. It burns the
 * whole acquisition timeout and reports `AUTHORIZATION_PARTITION_BUSY`, which
 * reads exactly like a busy neighbour and sent one investigation looking for a
 * leaked lease from a previous process. Work that needs the lock released
 * first belongs in `lease.afterRelease`.
 *
 * Scoped to the call path rather than the process on purpose: two concurrent
 * requests holding the same partition are real contention and must still
 * queue.
 */
const partitionsHeldOnThisPath = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Opaque proof that the caller currently owns one authorization partition.
 * Lifecycle coordinators may pass it across domain seams to extend the same
 * critical section without recursively acquiring the Postgres session lock.
 */
export class OwnerLockLease {
  private active = true;

  constructor(
    readonly ownerPartitionId: string,
    private readonly deferred: DeferredProjection[],
    token: typeof AUTHORIZATION_PARTITION_LEASE_TOKEN,
  ) {
    if (token !== AUTHORIZATION_PARTITION_LEASE_TOKEN) {
      throw new Error("authorization partition leases are coordinator-owned");
    }
  }

  assertPartition(ownerPartitionId: string): void {
    this.assertActive();
    if (ownerPartitionId !== this.ownerPartitionId) {
      throw new Error("authorization partition lease does not match scope");
    }
  }

  /** Run only after the coordinator has released the session lock. */
  afterRelease(operation: DeferredProjection): void {
    this.assertActive();
    this.deferred.push(operation);
  }

  close(): void {
    this.active = false;
  }

  private assertActive(): void {
    if (!this.active) {
      throw new Error("authorization partition lease is no longer active");
    }
  }
}

/** Cross-process ordering boundary for one authorization owner partition. */
export abstract class OwnerLock {
  async run<T>(
    ownerPartitionId: string,
    operation: (lease: OwnerLockLease) => Promise<T>,
  ): Promise<T> {
    refuseReentry(ownerPartitionId);
    const deferred: DeferredProjection[] = [];
    const lease = new OwnerLockLease(
      ownerPartitionId,
      deferred,
      AUTHORIZATION_PARTITION_LEASE_TOKEN,
    );
    // The deferred projections run OUTSIDE this scope, which is the whole
    // point of `afterRelease`: by then the lock is gone and the partition is
    // free for the projector to take on its own session.
    const result = await partitionsHeldOnThisPath.run(
      alsoHolding(ownerPartitionId),
      () =>
        this.runLocked(ownerPartitionId, async () => {
          try {
            return await operation(lease);
          } finally {
            lease.close();
          }
        }),
    );
    for (const projection of deferred) await projection();
    return result;
  }

  protected abstract runLocked<T>(
    ownerPartitionId: string,
    operation: () => Promise<T>,
  ): Promise<T>;
}

/**
 * Run `operation` as though a SEPARATE process were running it — outside the
 * partitions this call path holds.
 *
 * Exported only through `testing/`, and only for the interleavings that are
 * genuinely two workers in production: a projector that claimed a row before
 * a producer superseded it runs in its own process, so writing that test as a
 * nested call is an artifact of the test, not a design the wall should allow.
 * Production code that wants the lock released has `lease.afterRelease`.
 */
export function runOutsideHeldPartitions<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return partitionsHeldOnThisPath.exit(operation);
}

function refuseReentry(ownerPartitionId: string): void {
  const held = partitionsHeldOnThisPath.getStore();
  if (held?.has(ownerPartitionId) !== true) return;
  throw new Error(
    `authorization partition ${ownerPartitionId} is already held on this call path; ` +
      "defer the nested work with lease.afterRelease",
  );
}

function alsoHolding(ownerPartitionId: string): ReadonlySet<string> {
  const held = partitionsHeldOnThisPath.getStore();
  return new Set([...(held ?? []), ownerPartitionId]);
}
