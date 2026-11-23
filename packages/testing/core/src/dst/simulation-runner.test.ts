import { describe, expect, it } from "vitest";
import { defineSimAction, defineSimulation, runSimulation, SimulationFailureError } from "./index.js";

describe("DST simulation runner and delta-debugging shrinker", () => {
  it("passes across many seeds when invariants hold", async () => {
    type LedgerState = {
      balance: number;
      deposits: number;
      withdrawals: number;
    };

    const spec = defineSimulation<LedgerState>({
      name: "monotonic-ledger",
      createState: () => ({ balance: 0, deposits: 0, withdrawals: 0 }),
      actions: [
        defineSimAction({
          name: "deposit",
          weight: 3,
          generate: (_state, world) => world.rng.int(1, 50),
          execute: (state, amount) => {
            state.balance += amount;
            state.deposits += amount;
          },
        }),
        defineSimAction({
          name: "withdraw",
          enabled: (state) => state.balance > 0,
          generate: (state, world) => world.rng.int(1, state.balance),
          execute: (state, amount) => {
            state.balance -= amount;
            state.withdrawals += amount;
          },
        }),
      ],
      invariants: [
        {
          name: "non-negative-balance",
          check: (state) => {
            if (state.balance < 0) throw new Error(`Balance went negative: ${String(state.balance)}`);
          },
        },
        {
          name: "conservation",
          check: (state) => {
            if (state.balance !== state.deposits - state.withdrawals) {
              throw new Error("Conservation violated.");
            }
          },
        },
      ],
    });

    const report = await runSimulation(spec, { seeds: 20, steps: 30, env: {} });
    expect(report.ok).toBe(true);
    expect(report.seedsRun).toBe(20);
    expect(report.totalSteps).toBe(600);
  });

  it("shrinks a multi-step failure to a minimal repro and replays via DADS_DST_SEED", async () => {
    type BuggyState = {
      armed: boolean;
      noise: number;
      exploded: boolean;
    };

    const spec = defineSimulation<BuggyState>({
      name: "arm-and-trigger-bug",
      createState: () => ({ armed: false, noise: 0, exploded: false }),
      actions: [
        defineSimAction({
          name: "noop",
          weight: 6,
          generate: (_state, world) => world.rng.int(1, 99),
          execute: (state, value) => {
            state.noise += value;
          },
        }),
        defineSimAction({
          name: "arm",
          weight: 2,
          generate: () => null,
          execute: (state) => {
            state.armed = true;
          },
        }),
        defineSimAction({
          name: "trigger",
          weight: 2,
          generate: () => null,
          execute: (state) => {
            if (state.armed) state.exploded = true;
          },
        }),
      ],
      invariants: [
        {
          name: "never-explodes",
          check: (state) => {
            if (state.exploded) throw new Error("System exploded after arm + trigger.");
          },
        },
      ],
    });

    let caught: SimulationFailureError | undefined;
    try {
      await runSimulation(spec, { seeds: 15, steps: 40, baseSeed: 100, env: {} });
    } catch (error: unknown) {
      if (error instanceof SimulationFailureError) caught = error;
      else throw error;
    }

    expect(caught).toBeDefined();
    expect(caught?.detail.failedAt).toBe("invariant:never-explodes");
    expect(caught?.detail.minimizedSteps.map((step) => step.action)).toEqual(["arm", "trigger"]);
    expect(caught?.detail.originalStepCount).toBeGreaterThanOrEqual(2);

    // Replaying via DADS_DST_SEED reproduces the exact same seed and minimal sequence
    let replayed: SimulationFailureError | undefined;
    try {
      await runSimulation(spec, {
        seeds: 999,
        steps: 40,
        env: { DADS_DST_SEED: String(caught?.detail.seed ?? 0) },
      });
    } catch (error: unknown) {
      if (error instanceof SimulationFailureError) replayed = error;
      else throw error;
    }
    expect(replayed?.detail.seed).toBe(caught?.detail.seed);
    expect(replayed?.detail.minimizedSteps).toEqual(caught?.detail.minimizedSteps);
  });
});
