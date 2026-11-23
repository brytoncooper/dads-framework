import { createSeededRng, resolveDstSeed, type DstSeedInput, type SeededRng } from "./prng.js";
import { createSimClock, createUuidV7Generator, type SimClock, type SimClockInput } from "./sim-clock.js";

/**
 * A self-contained deterministic simulation world: one seed drives the PRNG,
 * simulated clock, monotonic UUIDv7 generator, and structured event trace.
 */

export type SimTraceEvent = {
  readonly index: number;
  readonly timestampMs: number;
  readonly kind: string;
  readonly detail?: Readonly<Record<string, unknown>>;
};

export type SimWorldOptions = {
  readonly seed?: DstSeedInput;
  readonly startTime?: SimClockInput;
  readonly env?: NodeJS.ProcessEnv;
};

export type SimWorld = {
  readonly seed: number;
  readonly rng: SeededRng;
  readonly clock: SimClock;
  readonly trace: readonly SimTraceEvent[];
  nextUuidV7(): string;
  forkRng(label: string): SeededRng;
  record(kind: string, detail?: Readonly<Record<string, unknown>>): void;
};

export function createSimWorld(options: SimWorldOptions = {}): SimWorld {
  const resolved =
    options.seed !== undefined ? { seed: createSeededRng(options.seed).seed } : resolveDstSeed(1, options.env);
  const rng = createSeededRng(resolved.seed);
  const clock = createSimClock(options.startTime);
  const nextUuidV7 = createUuidV7Generator(clock, rng.fork("uuidv7"));
  const trace: SimTraceEvent[] = [];

  return {
    seed: rng.seed,
    rng,
    clock,
    trace,
    nextUuidV7,
    forkRng: (label: string): SeededRng => rng.fork(label),
    record: (kind: string, detail?: Readonly<Record<string, unknown>>): void => {
      trace.push({
        index: trace.length,
        timestampMs: clock.nowMs(),
        kind,
        ...(detail === undefined ? {} : { detail }),
      });
    },
  };
}
