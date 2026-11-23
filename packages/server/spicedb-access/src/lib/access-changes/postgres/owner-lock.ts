import { setTimeout as sleep } from "node:timers/promises";
import { AsyncLocalStorage } from "node:async_hooks";

import { conflict } from "@dads-framework/core/errors";
import { OwnerLock } from "@dads-framework/access/runtime";

const AUTHORIZATION_PARTITION_LOCK_NAMESPACE = 719_405;
const DEFAULT_ACQUISITION_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_DELAY_MS = 10;

type AuthorizationLockClient = {
  query(
    statement: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  release(destroy?: boolean): void;
};

type AuthorizationLockPool = {
  readonly options?: { readonly max?: number };
  connect(): Promise<AuthorizationLockClient>;
};

/**
 * Connections a flow's first lock must leave to non-lock work. A lock holder
 * keeps its lock connection while its operation checks out another, so lock
 * holders (this lock's, the participant coordinator's, a site's puller and
 * outbox sender) must never own the whole pool between them: each would wait
 * on the others for a connection, for good.
 *
 * Only connections held FOR LOCKS count. Plain queries and callers queued in
 * pg's own FIFO are ignored: they release on their own, so they cannot close
 * that cycle, and counting them would turn ordinary load into refused access
 * writes. A lock taken NESTED, on a call path that already holds a lock
 * connection, is not a new flow (the outer holder is waiting on it), so it
 * leaves only {@link NESTED_LOCK_HOLDER_FREE_CONNECTIONS}.
 */
export const LOCK_HOLDER_FREE_CONNECTIONS = 2;

/** What a lock nested inside another lock on the same call path leaves free. */
export const NESTED_LOCK_HOLDER_FREE_CONNECTIONS = 1;

/** The pool a lock connection is reserved against; only its size is read. */
export type LockConnectionPool = {
  readonly options?: { readonly max?: number };
};

const lockConnectionHeldOnThisPath = new AsyncLocalStorage<true>();

/** Per pool object: how many of its connections lock holders hold right now. */
const lockConnectionsHeld = new WeakMap<LockConnectionPool, number>();

/**
 * Runs `operation` marked as holding a lock connection, so a lock taken
 * inside it reserves as nested ({@link reserveLockConnection}). Every lock
 * that keeps a pooled connection while its operation runs calls this around
 * that operation.
 */
export function runHoldingLockConnection<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return lockConnectionHeldOnThisPath.run(true, operation);
}

/**
 * Reserves one of `pool`'s connections for a lock holder, before it checks
 * the connection out, or answers null when lock holders would then hold more
 * than `max - LOCK_HOLDER_FREE_CONNECTIONS` (`max - 1` when nested; never
 * fewer than one). The answer releases the reservation; call it once the
 * lock's connection is back in the pool. A pool that reports no `max` is
 * not limited, only counted.
 */
export function reserveLockConnection(
  pool: LockConnectionPool,
): (() => void) | null {
  const held = lockConnectionsHeld.get(pool) ?? 0;
  const max = pool.options?.max;
  if (max !== undefined) {
    const leaveFree =
      lockConnectionHeldOnThisPath.getStore() === true
        ? NESTED_LOCK_HOLDER_FREE_CONNECTIONS
        : LOCK_HOLDER_FREE_CONNECTIONS;
    if (held + 1 > Math.max(1, max - leaveFree)) return null;
  }
  lockConnectionsHeld.set(pool, held + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockConnectionsHeld.set(pool, (lockConnectionsHeld.get(pool) ?? 1) - 1);
  };
}

type CoordinatorLog = {
  warn(value: object, message?: string): void;
};

type CoordinatorOptions = {
  readonly acquisitionTimeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly maxConcurrentLockClients?: number;
  readonly now?: () => number;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly log?: CoordinatorLog;
};

type AcquiredLock = {
  readonly client: AuthorizationLockClient;
  releasePermit(): void;
};

const SILENT_LOG: CoordinatorLog = { warn: () => undefined };

/** Holds a partition session lock on one dedicated pooled client. */
export class PostgresOwnerLock extends OwnerLock {
  private readonly acquisitionTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxConcurrentLockClients: number;
  private readonly now: () => number;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly log: CoordinatorLog;
  private activePermits = 0;

  constructor(
    private readonly pool: AuthorizationLockPool,
    options: CoordinatorOptions = {},
  ) {
    super();
    this.acquisitionTimeoutMs =
      options.acquisitionTimeoutMs ?? DEFAULT_ACQUISITION_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const poolMaximum = pool.options?.max ?? 3;
    this.maxConcurrentLockClients =
      options.maxConcurrentLockClients ?? Math.max(1, poolMaximum - 2);
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? sleep;
    this.log = options.log ?? SILENT_LOG;
  }

  protected async runLocked<T>(
    ownerPartitionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const acquired = await this.acquire(ownerPartitionId);
    try {
      return await runHoldingLockConnection(operation);
    } finally {
      await this.release(acquired, ownerPartitionId);
    }
  }

  private async acquire(ownerPartitionId: string): Promise<AcquiredLock> {
    const deadline = this.now() + this.acquisitionTimeoutMs;
    while (this.now() <= deadline) {
      const acquired = await this.tryAcquire(ownerPartitionId, deadline);
      if (acquired !== null) return acquired;
      await this.waitForRetry(deadline);
    }
    throw acquisitionTimeout();
  }

  private async tryAcquire(
    ownerPartitionId: string,
    deadline: number,
  ): Promise<AcquiredLock | null> {
    const releasePermit = this.tryAcquirePermit();
    if (releasePermit === null) return null;
    let client: AuthorizationLockClient;
    try {
      client = await this.connectWithin(deadline);
    } catch (error) {
      releasePermit();
      throw error;
    }
    return this.tryLock(client, releasePermit, ownerPartitionId);
  }

  private async tryLock(
    client: AuthorizationLockClient,
    releasePermit: () => void,
    ownerPartitionId: string,
  ): Promise<AcquiredLock | null> {
    try {
      const result = await client.query(
        "select pg_try_advisory_lock(hashtextextended($1, $2)) as acquired",
        [ownerPartitionId, AUTHORIZATION_PARTITION_LOCK_NAMESPACE],
      );
      if (result.rows[0]?.["acquired"] === true) {
        return { client, releasePermit };
      }
      client.release();
      releasePermit();
      return null;
    } catch (error) {
      client.release(true);
      releasePermit();
      throw error;
    }
  }

  private async release(
    acquired: AcquiredLock,
    ownerPartitionId: string,
  ): Promise<void> {
    let unlockFailure: Error | null = null;
    try {
      const result = await acquired.client.query(
        "select pg_advisory_unlock(hashtextextended($1, $2)) as unlocked",
        [ownerPartitionId, AUTHORIZATION_PARTITION_LOCK_NAMESPACE],
      );
      if (result.rows[0]?.["unlocked"] !== true) {
        unlockFailure = new Error("authorization partition lock was not held");
      }
    } catch (error) {
      unlockFailure = normalizeError(error);
    }
    acquired.client.release(unlockFailure !== null);
    acquired.releasePermit();
    if (unlockFailure !== null) {
      this.log.warn(
        { ownerPartitionId, error: unlockFailure.message },
        "Authorization partition unlock failed; destroyed session",
      );
    }
  }

  private tryAcquirePermit(): (() => void) | null {
    if (this.activePermits >= this.maxConcurrentLockClients) return null;
    const releaseReservation = reserveLockConnection(this.pool);
    if (releaseReservation === null) return null;
    this.activePermits += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activePermits -= 1;
      releaseReservation();
    };
  }

  private connectWithin(deadline: number): Promise<AuthorizationLockClient> {
    const remaining = deadline - this.now();
    if (remaining <= 0) return Promise.reject(acquisitionTimeout());
    return connectBefore(this.pool.connect(), remaining);
  }

  private async waitForRetry(deadline: number): Promise<void> {
    const remaining = deadline - this.now();
    if (remaining <= 0) throw acquisitionTimeout();
    await this.delay(Math.min(this.retryDelayMs, remaining));
  }
}

function connectBefore(
  connection: Promise<AuthorizationLockClient>,
  timeoutMs: number,
): Promise<AuthorizationLockClient> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(acquisitionTimeout());
    }, timeoutMs);
    const accept = (client: AuthorizationLockClient): void => {
      if (settled) {
        client.release();
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(client);
    };
    const refuse = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(normalizeError(error));
    };
    connection.then(accept, refuse);
  });
}

function acquisitionTimeout(): Error {
  return conflict(
    "AUTHORIZATION_PARTITION_BUSY",
    "Authorization partition is temporarily busy",
  );
}

function normalizeError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("authorization partition operation failed");
}
