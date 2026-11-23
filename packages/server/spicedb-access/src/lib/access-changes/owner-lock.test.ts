/**
 * The partition coordinator's own rules, independent of any driver: no nested
 * locks, and `afterRelease` as the sanctioned way to do the work
 * that needs the lock gone.
 *
 * The nesting wall is the interesting one. Re-entering a partition is not
 * contention that clears — the real lock lives on a POOLED SESSION, and a
 * Postgres advisory lock is re-entrant only within one session, so the caller
 * is waiting for itself. Left unwalled it looks exactly like a busy
 * neighbour: the acquisition timeout elapses, `AUTHORIZATION_PARTITION_BUSY`
 * comes back, and the fact that caused it stays PENDING.
 */
import { describe, expect, it } from "vitest";
import { InMemoryOwnerLock } from "../../testing/in-memory-owner-lock.js";
import type { OwnerLockLease } from "@dads-framework/access/runtime";

const PARTITION = "0a52ce02-96b2-4f4a-9c1e-8f2d3b7a4e01";
const OTHER_PARTITION = "0a52ce02-96b2-4f4a-9c1e-8f2d3b7a4e02";

describe("OwnerLock", () => {
  it("refuses a partition the same call path already holds", async () => {
    const coordinator = new InMemoryOwnerLock();

    await expect(
      coordinator.run(PARTITION, () => coordinator.run(PARTITION, () => Promise.resolve("nested"))),
    ).rejects.toThrow("already held on this call path");
  });

  it("refuses re-entry through a second coordinator over the same partition", async () => {
    // Two instances, one Postgres partition: the wall follows the partition,
    // not the object that happens to be holding it.
    const outer = new InMemoryOwnerLock();
    const inner = new InMemoryOwnerLock();

    await expect(outer.run(PARTITION, () => inner.run(PARTITION, () => Promise.resolve("nested")))).rejects.toThrow(
      "already held on this call path",
    );
  });

  it("allows a nested acquisition of a different partition", async () => {
    const coordinator = new InMemoryOwnerLock();

    await expect(
      coordinator.run(PARTITION, () => coordinator.run(OTHER_PARTITION, () => Promise.resolve("nested"))),
    ).resolves.toBe("nested");
  });

  it("frees the partition for the work deferred to afterRelease", async () => {
    const coordinator = new InMemoryOwnerLock();
    const order: string[] = [];

    await coordinator.run(PARTITION, (lease) => {
      lease.afterRelease(async () => {
        // Exactly what the inline projector does: take the partition itself.
        await coordinator.run(PARTITION, () => {
          order.push("projected");
          return Promise.resolve();
        });
      });
      order.push("saved");
      return Promise.resolve();
    });

    expect(order).toEqual(["saved", "projected"]);
  });

  it("still serializes two concurrent callers over one partition", async () => {
    // Call-path scoped, not process scoped: independent requests contend.
    const coordinator = new InMemoryOwnerLock();
    const order: string[] = [];
    let releaseFirst = (): void => undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = coordinator.run(PARTITION, async () => {
      order.push("first-in");
      await firstMayFinish;
      order.push("first-out");
    });
    const second = coordinator.run(PARTITION, () => {
      order.push("second-in");
      return Promise.resolve();
    });
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first-in", "first-out", "second-in"]);
  });

  it("releases the call path once the lock is gone", async () => {
    const coordinator = new InMemoryOwnerLock();

    await coordinator.run(PARTITION, () => Promise.resolve());

    await expect(coordinator.run(PARTITION, () => Promise.resolve("again"))).resolves.toBe("again");
  });

  it("closes the lease when the operation throws, so nothing can defer onto a dead lock", async () => {
    const coordinator = new InMemoryOwnerLock();
    let escaped: OwnerLockLease | null = null;

    await expect(
      coordinator.run(PARTITION, (lease) => {
        escaped = lease;
        return Promise.reject(new Error("operation failed"));
      }),
    ).rejects.toThrow("operation failed");
    expect(() => {
      closed(escaped).afterRelease(() => Promise.resolve());
    }).toThrow("no longer active");
  });
});

function closed(lease: OwnerLockLease | null): OwnerLockLease {
  if (lease === null) throw new Error("Expected the operation to see a lease");
  return lease;
}
