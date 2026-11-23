import { describe, expect, it } from "vitest";
import { createSeededRng, createSimWorld, defaultSimStartMs, parseSeed, resolveDstSeed } from "./index.js";

describe("DST PRNG, clock, and UUIDv7 world", () => {
  it("reproduces identical RNG draws, timestamps, and UUIDv7s from the same seed", () => {
    const first = createSimWorld({ seed: "notes-seed-42" });
    const second = createSimWorld({ seed: "notes-seed-42" });

    expect(first.seed).toBe(second.seed);
    expect(first.clock.nowMs()).toBe(defaultSimStartMs);
    expect(first.clock.now()).toBeInstanceOf(Date);

    const firstIds = [first.nextUuidV7(), first.nextUuidV7(), first.nextUuidV7()];
    const secondIds = [second.nextUuidV7(), second.nextUuidV7(), second.nextUuidV7()];
    expect(firstIds).toEqual(secondIds);

    for (const id of firstIds) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    }
    // Strictly monotonic within the same simulated millisecond
    const [id0 = "", id1 = "", id2 = ""] = firstIds;
    expect(id0 < id1).toBe(true);
    expect(id1 < id2).toBe(true);
  });

  it("isolates forked RNG streams and shuffles without mutating input", () => {
    const rng = createSeededRng(777);
    const streamA = rng.fork("alpha");
    const streamB = rng.fork("beta");

    expect(streamA.seed).not.toBe(streamB.seed);
    expect(rng.fork("alpha").int(1, 1000)).toBe(streamA.int(1, 1000));

    const original = [1, 2, 3, 4, 5, 6];
    const shuffled = rng.shuffle(original);
    expect(original).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(original);
  });

  it("supports clock advance, jumpTo, skew, and DADS_DST_SEED env override", () => {
    const world = createSimWorld({ seed: 9, startTime: "2026-06-01T12:00:00.000Z" });
    world.clock.advance(5_000);
    expect(world.clock.iso()).toBe("2026-06-01T12:00:05.000Z");

    world.clock.skew(-2_000);
    expect(world.clock.iso()).toBe("2026-06-01T12:00:03.000Z");

    world.clock.jumpTo("2026-06-02T00:00:00.000Z");
    expect(world.clock.iso()).toBe("2026-06-02T00:00:00.000Z");

    expect(() => world.clock.advance(-1)).toThrow("non-negative");
    expect(parseSeed("0xff")).toBe(255);
    expect(resolveDstSeed(1, { DADS_DST_SEED: "4242" })).toEqual({ seed: 4242, fromEnv: true });
    expect(resolveDstSeed(99, {})).toEqual({ seed: 99, fromEnv: false });
  });
});
