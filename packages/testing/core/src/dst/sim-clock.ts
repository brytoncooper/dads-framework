import type { SeededRng } from "./prng.js";

/**
 * Deterministic simulated clock and RFC 9562 UUIDv7 generator.
 *
 * `SimClock.now()` returns a `Date`, matching `@dads-framework/core`'s `Clock`
 * structurally so `provideClock(world.clock)` works with zero adapters.
 */

export type SimClockInput = number | Date | string;

export type SimClock = {
  /** Current simulated timestamp as a `Date` (compatible with `@dads-framework/core` `Clock`). */
  now(): Date;
  /** Current simulated timestamp in epoch milliseconds. */
  nowMs(): number;
  /** Current simulated timestamp as an ISO-8601 UTC string. */
  iso(): string;
  /** Advances the clock forward by `ms` milliseconds (`ms >= 0`). */
  advance(ms: number): Date;
  /** Jumps the clock to a specific timestamp (forward or backward). */
  jumpTo(target: SimClockInput): Date;
  /** Shifts the clock by `deltaMs` (positive or negative) to simulate clock skew. */
  skew(deltaMs: number): Date;
};

/** Fixed deterministic epoch (`2026-01-01T00:00:00.000Z`) when no start time is passed. */
export const defaultSimStartMs = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

export function createSimClock(startTime: SimClockInput = defaultSimStartMs): SimClock {
  let currentMs = parseTimestampMs(startTime);

  return {
    now: (): Date => new Date(currentMs),
    nowMs: (): number => currentMs,
    iso: (): string => new Date(currentMs).toISOString(),
    advance: (ms: number): Date => {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error(`SimClock.advance requires a non-negative finite ms value; got ${String(ms)}.`);
      }
      currentMs += Math.trunc(ms);
      return new Date(currentMs);
    },
    jumpTo: (target: SimClockInput): Date => {
      currentMs = parseTimestampMs(target);
      return new Date(currentMs);
    },
    skew: (deltaMs: number): Date => {
      if (!Number.isFinite(deltaMs)) {
        throw new Error(`SimClock.skew requires a finite deltaMs; got ${String(deltaMs)}.`);
      }
      currentMs += Math.trunc(deltaMs);
      return new Date(currentMs);
    },
  };
}

/**
 * Generates deterministic, monotonic RFC 9562 UUIDv7 strings driven solely by
 * `clock` and `rng`. Multiple calls within the same simulated millisecond bump
 * the 12-bit sub-millisecond counter so sort order stays strictly monotonic.
 */
export function createUuidV7Generator(clock: SimClock, rng: SeededRng): () => string {
  let lastMs = -1;
  let seq = 0;

  return (): string => {
    const rawMs = Math.max(0, clock.nowMs());
    if (rawMs === lastMs) {
      seq = (seq + 1) & 0x0fff;
    } else {
      lastMs = rawMs;
      seq = rng.int(0, 0x03ff);
    }

    const bytes = rng.bytes(16);
    writeTimestamp48(bytes, rawMs);
    bytes[6] = 0x70 | ((seq >>> 8) & 0x0f);
    bytes[7] = seq & 0xff;
    bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
    return formatUuid(bytes);
  };
}

function parseTimestampMs(input: SimClockInput): number {
  const ms = input instanceof Date ? input.getTime() : typeof input === "string" ? Date.parse(input) : input;
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid SimClock timestamp: ${String(input)}.`);
  }
  return Math.trunc(ms);
}

function writeTimestamp48(bytes: Uint8Array, timestampMs: number): void {
  const high = Math.floor(timestampMs / 0x1_0000_0000);
  const low = timestampMs >>> 0;
  bytes[0] = (high >>> 8) & 0xff;
  bytes[1] = high & 0xff;
  bytes[2] = (low >>> 24) & 0xff;
  bytes[3] = (low >>> 16) & 0xff;
  bytes[4] = (low >>> 8) & 0xff;
  bytes[5] = low & 0xff;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
