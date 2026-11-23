/**
 * Session locks must release safely, time out without consuming the pool, and
 * preserve domain errors when the underlying connection is damaged.
 */
import { describe, expect, it } from "vitest";
import {
  PostgresOwnerLock,
  reserveLockConnection,
  runHoldingLockConnection,
} from "./owner-lock.js";

type LockOutcome = "acquired" | "contended";
type UnlockOutcome = "released" | "not-held" | "throws";

class LockClient {
  readonly releases: boolean[] = [];

  constructor(
    private readonly unlockOutcome: UnlockOutcome,
    private readonly lockOutcome: LockOutcome = "acquired",
  ) {}

  query(
    statement: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }> {
    void values;
    if (statement.includes("pg_try_advisory_lock")) {
      return Promise.resolve({
        rows: [{ acquired: this.lockOutcome === "acquired" }],
      });
    }
    if (this.unlockOutcome === "throws") {
      return Promise.reject(new Error("unlock connection lost"));
    }
    return Promise.resolve({
      rows: [{ unlocked: this.unlockOutcome === "released" }],
    });
  }

  release(destroy = false): void {
    this.releases.push(destroy);
  }
}

class RecordingLog {
  readonly warnings: object[] = [];
  warn(value: object): void {
    this.warnings.push(value);
  }
}

class LockPool {
  readonly options = { max: 3 };
  connectCalls = 0;

  constructor(readonly client: LockClient) {}

  connect(): Promise<LockClient> {
    this.connectCalls += 1;
    return Promise.resolve(this.client);
  }
}

describe("PostgresOwnerLock", () => {
  it("destroys a client when Postgres reports that no lock was released", async () => {
    const pool = new LockPool(new LockClient("not-held"));
    const log = new RecordingLog();
    const coordinator = new PostgresOwnerLock(pool, {
      log,
    });

    await expect(
      coordinator.run("organization:1", () => Promise.resolve("done")),
    ).resolves.toBe("done");
    expect(pool.client.releases).toEqual([true]);
    expect(log.warnings).toHaveLength(1);
  });

  it("destroys a client when the unlock query throws", async () => {
    const pool = new LockPool(new LockClient("throws"));
    const log = new RecordingLog();
    const coordinator = new PostgresOwnerLock(pool, {
      log,
    });

    await expect(
      coordinator.run("organization:1", () => Promise.resolve("done")),
    ).resolves.toBe("done");
    expect(pool.client.releases).toEqual([true]);
    expect(log.warnings).toHaveLength(1);
  });

  it("preserves the operation error when unlocking also fails", async () => {
    const pool = new LockPool(new LockClient("throws"));
    const log = new RecordingLog();
    const coordinator = new PostgresOwnerLock(pool, {
      log,
    });

    await expect(
      coordinator.run("organization:1", () =>
        Promise.reject(new Error("operation failed")),
      ),
    ).rejects.toThrow("operation failed");
    expect(pool.client.releases).toEqual([true]);
    expect(log.warnings).toHaveLength(1);
  });

  it("times out contended try-lock attempts and releases each client", async () => {
    let now = 0;
    const pool = new LockPool(new LockClient("released", "contended"));
    const coordinator = new PostgresOwnerLock(pool, {
      acquisitionTimeoutMs: 20,
      retryDelayMs: 10,
      now: () => now,
      delay: (milliseconds) => {
        now += milliseconds;
        return Promise.resolve();
      },
    });

    await expect(
      coordinator.run("organization:1", () => Promise.resolve()),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_PARTITION_BUSY" });
    expect(pool.connectCalls).toBe(2);
    expect(pool.client.releases).toEqual([false, false]);
  });

  it("keeps contending callers behind the local pool-headroom permit", async () => {
    const pool = new LockPool(new LockClient("released"));
    const coordinator = new PostgresOwnerLock(pool, {
      maxConcurrentLockClients: 1,
      acquisitionTimeoutMs: 100,
      retryDelayMs: 1,
    });
    let releaseFirst = (): void => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let allowFirst = (): void => undefined;
    const firstReleased = new Promise<void>((resolve) => {
      allowFirst = resolve;
    });
    const first = coordinator.run("organization:1", async () => {
      releaseFirst();
      await firstReleased;
    });
    await firstStarted;

    const second = coordinator.run("organization:2", () => Promise.resolve());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(pool.connectCalls).toBe(1);

    allowFirst();
    await Promise.all([first, second]);
    expect(pool.connectCalls).toBe(2);
  });

  it("takes no lock connection once other lock holders hold all but two of the pool", async () => {
    let now = 0;
    const pool = Object.assign(new LockPool(new LockClient("released")), {
      options: { max: 5 },
    });
    const othersHolding = [
      reserveLockConnection(pool),
      reserveLockConnection(pool),
      reserveLockConnection(pool),
    ];
    const coordinator = new PostgresOwnerLock(pool, {
      maxConcurrentLockClients: 5,
      acquisitionTimeoutMs: 20,
      retryDelayMs: 10,
      now: () => now,
      delay: (milliseconds) => {
        now += milliseconds;
        return Promise.resolve();
      },
    });

    await expect(
      coordinator.run("organization:1", () => Promise.resolve()),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_PARTITION_BUSY" });
    expect(pool.connectCalls).toBe(0);

    for (const release of othersHolding) release?.();
    await expect(
      coordinator.run("organization:1", () => Promise.resolve("served")),
    ).resolves.toBe("served");
  });

  it("is served under any amount of plain load: only lock holders count", async () => {
    const pool = Object.assign(new LockPool(new LockClient("released")), {
      options: { max: 10 },
      totalCount: 10,
      idleCount: 0,
      waitingCount: 50,
    });
    const coordinator = new PostgresOwnerLock(pool);

    await expect(
      coordinator.run("organization:1", () => Promise.resolve("served")),
    ).resolves.toBe("served");
  });
});

describe("reserveLockConnection", () => {
  it("leaves two connections to non-lock work, one inside a held lock, and frees on release", async () => {
    const pool = { options: { max: 5 } };
    const first = [1, 2, 3].map(() => reserveLockConnection(pool));
    expect(first.every((release) => release !== null)).toBe(true);
    expect(reserveLockConnection(pool)).toBeNull();

    const nested = await runHoldingLockConnection(() =>
      Promise.resolve([
        reserveLockConnection(pool),
        reserveLockConnection(pool),
      ]),
    );
    expect(nested[0]).not.toBeNull();
    expect(nested[1]).toBeNull();

    nested[0]?.();
    first[0]?.();
    first[0]?.();
    expect(reserveLockConnection(pool)).not.toBeNull();
    expect(reserveLockConnection(pool)).toBeNull();
  });

  it("never lets lock holders take every connection of any pool size, so they cannot wait on each other for good", async () => {
    for (let max = 2; max <= 12; max += 1) {
      const pool = { options: { max } };
      let held = 0;
      while (reserveLockConnection(pool) !== null) held += 1;
      await runHoldingLockConnection(() => {
        while (reserveLockConnection(pool) !== null) held += 1;
        return Promise.resolve();
      });
      expect(held, `pool of ${String(max)}`).toBeLessThan(max);
    }
  });

  it("counts but never refuses for a pool that reports no size", () => {
    const pool = {};
    for (let index = 0; index < 50; index += 1) {
      expect(reserveLockConnection(pool)).not.toBeNull();
    }
  });
});
