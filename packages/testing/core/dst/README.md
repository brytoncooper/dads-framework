# Dads Deterministic Simulation Testing (`@dads-framework/testing/dst`)

`@dads-framework/testing/dst` lets you fuzz stateful workflows, retries, clock
boundaries, at-least-once queues, and mid-stream revocations in milliseconds of
simulated time with one reproducible seed.

## What Dad does for you

A real concurrency or timeout bug usually hides behind 20 seconds of sleeps and
only fails on Fridays. Here one seed controls every random choice, timestamp,
and UUIDv7. When an invariant breaks, Dad shrinks the failing sequence to the
smallest repro and hands you `DADS_DST_SEED=<seed>` to replay it on demand.

## Try it

```ts
import {
  createFaultyTransactionRunner,
  defineSimAction,
  defineSimulation,
  runSimulation,
} from "@dads-framework/testing/dst";

const spec = defineSimulation({
  name: "idempotent-counter",
  createState: (world) => ({
    runner: createFaultyTransactionRunner(world, { serializationFailureRate: 0.4, maxAttempts: 8 }),
    applied: new Set<string>(),
    total: 0,
  }),
  actions: [
    defineSimAction({
      name: "credit",
      generate: (_state, world) => ({ id: world.nextUuidV7(), amount: world.rng.int(1, 20) }),
      execute: async (state, input) => {
        await state.runner.run(() => {
          if (state.applied.has(input.id)) return;
          state.applied.add(input.id);
          state.total += input.amount;
        });
      },
    }),
  ],
  invariants: [
    {
      name: "non-negative",
      check: (state) => {
        if (state.total < 0) throw new Error("Counter went negative.");
      },
    },
  ],
});

await runSimulation(spec, { seeds: 25, steps: 40 });
```

## Primitives

- **`createSimWorld({ seed, startTime })`**: combines a seeded PRNG (`rng`,
  `forkRng`), a `SimClock` (`clock.now()` returns `Date`, structurally compatible
  with `@dads-framework/core`'s `Clock` and `provideClock`), a monotonic RFC 9562
  `nextUuidV7()`, and a structured event trace (`trace`, `record`).
- **`defineSimAction` / `defineSimulation` / `runSimulation`**: executes weighted
  stateful action sequences across multiple seeds, checks every invariant after
  every step, shrinks failures via delta-debugging, and replays any single seed
  when `DADS_DST_SEED=<seed>` is set in the environment.
- **Fault-injecting adapters**:
  - `createFaultyTransactionRunner`: injects Postgres `40001` serialization
    failures and `40P01` deadlocks with simulated backoff on `world.clock`.
  - `createExpiringTokenStore`: clock-driven TTL and revocation store for testing
    `expiresAt` boundaries and NTP skew.
  - `createFaultyDeliveryQueue`: at-least-once delivery with duplicates, drops,
    reordering, and simulated delay jitter for proving idempotency handlers.
  - `createFaultyEventStream`: SSE/channel stream simulator with disconnects,
    cursor catch-up, and permanent mid-stream revocation.
