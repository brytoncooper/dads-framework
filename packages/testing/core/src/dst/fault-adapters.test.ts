import { describe, expect, it } from "vitest";
import {
  createExpiringTokenStore,
  createFaultyDeliveryQueue,
  createFaultyEventStream,
  createFaultyTransactionRunner,
  createSimWorld,
  SimulatedPostgresError,
} from "./index.js";

describe("DST fault-injecting adapters", () => {
  it("retries injected 40001 and 40P01 Postgres errors using simulated backoff", async () => {
    const world = createSimWorld({ seed: 2026 });
    const runner = createFaultyTransactionRunner(world, {
      serializationFailureRate: 0.45,
      deadlockRate: 0.1,
      maxAttempts: 10,
      retryBackoffMs: 25,
    });

    let committed = 0;
    for (let i = 0; i < 20; i += 1) {
      const value = await runner.run(() => {
        committed += 1;
        return committed;
      });
      expect(value).toBe(committed);
    }

    const stats = runner.stats();
    expect(stats.succeeded).toBe(20);
    expect(stats.injected40001 + stats.injected40P01).toBeGreaterThan(0);
    expect(stats.retries).toBe(stats.injected40001 + stats.injected40P01);
    expect(world.clock.nowMs()).toBeGreaterThan(Date.UTC(2026, 0, 1));
  });

  it("throws SimulatedPostgresError when retries are exhausted", async () => {
    const world = createSimWorld({ seed: 7 });
    const runner = createFaultyTransactionRunner(world, {
      serializationFailureRate: 1,
      deadlockRate: 0,
      maxAttempts: 3,
    });

    await expect(runner.run(() => "never")).rejects.toBeInstanceOf(SimulatedPostgresError);
    expect(runner.stats().exhausted).toBe(1);
    expect(runner.stats().attempts).toBe(3);
  });

  it("enforces token TTLs across simulated clock jumps and revocations", () => {
    const world = createSimWorld({ seed: 11 });
    const store = createExpiringTokenStore<{ readonly userId: string }>(world);

    const tokenA = store.issue({ userId: "u-1" }, 60_000);
    const tokenB = store.issue({ userId: "u-2" }, 120_000);
    expect(store.activeCount()).toBe(2);

    world.clock.advance(59_999);
    expect(store.verify(tokenA.id)?.payload.userId).toBe("u-1");

    world.clock.advance(1);
    expect(store.verify(tokenA.id)).toBeUndefined();
    expect(store.verify(tokenB.id)?.payload.userId).toBe("u-2");
    expect(store.activeCount()).toBe(1);

    expect(store.revoke(tokenB.id)).toBe(true);
    expect(store.verify(tokenB.id)).toBeUndefined();
    expect(store.activeCount()).toBe(0);
  });

  it("injects duplicate and out-of-order deliveries so idempotency guards are proven", async () => {
    const world = createSimWorld({ seed: 55 });
    const queue = createFaultyDeliveryQueue<{ readonly orderId: string; readonly delta: number }>(world, {
      duplicateRate: 0.6,
      dropRate: 0,
      reorderRate: 0.7,
      maxDelayMs: 200,
    });

    for (let i = 1; i <= 15; i += 1) {
      queue.enqueue({ orderId: `ord-${String(i)}`, delta: 10 }, `msg-${String(i)}`);
    }

    const appliedIds = new Set<string>();
    let totalApplied = 0;
    await queue.drainAll((envelope) => {
      if (appliedIds.has(envelope.messageId)) return;
      appliedIds.add(envelope.messageId);
      totalApplied += envelope.payload.delta;
    });

    expect(queue.stats().duplicatesInjected).toBeGreaterThan(0);
    expect(appliedIds.size).toBe(15);
    expect(totalApplied).toBe(150);
  });

  it("blocks all future events and reconnects after mid-stream SSE revocation", () => {
    const world = createSimWorld({ seed: 33 });
    const stream = createFaultyEventStream<{ readonly seq: number }>(world);

    const alice = stream.subscribe("alice");
    const bob = stream.subscribe("bob");

    stream.publish({ seq: 1 });
    bob.disconnect();
    stream.publish({ seq: 2 });

    // Bob reconnects and catches up cleanly
    expect(bob.reconnect()).toBe(true);
    expect(bob.received).toEqual([{ seq: 1 }, { seq: 2 }]);

    // Alice is revoked mid-stream: zero subsequent events and reconnect is refused
    alice.revoke();
    stream.publish({ seq: 3 });
    expect(alice.received).toEqual([{ seq: 1 }, { seq: 2 }]);
    expect(alice.reconnect()).toBe(false);
    expect(bob.received).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
  });
});
