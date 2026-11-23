/**
 * Deterministic PRNG for simulation testing.
 *
 * Uses Mulberry32 mixed with FNV-1a string hashing so any integer, hex string,
 * or human label produces an identical, cross-platform stream of draws.
 */

export type DstSeedInput = number | string;

export type SeededRng = {
  readonly seed: number;
  /** Uniform float in `[0, 1)`. */
  nextFloat(): number;
  /** Uniform integer in `[minInclusive, maxInclusive]`. */
  int(minInclusive: number, maxInclusive: number): number;
  /** Returns true with probability `p` (defaults to `0.5`). */
  bool(probability?: number): boolean;
  /** Picks one element uniformly from a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Returns a deterministically shuffled copy without mutating `items`. */
  shuffle<T>(items: readonly T[]): T[];
  /** Fills a new `Uint8Array` of length `length` with deterministic bytes. */
  bytes(length: number): Uint8Array;
  /** Derives an independent child RNG from this stream's seed and a label. */
  fork(label: string): SeededRng;
};

/** Parses an integer, hex string (`0x...`), or arbitrary label into a uint32 seed. */
export function parseSeed(raw: DstSeedInput): number {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      throw new Error(`DST seed must be a finite number; got ${String(raw)}.`);
    }
    return Math.trunc(raw) >>> 0;
  }
  const trimmed = raw.trim();
  if (/^0x[0-9a-f]+$/iu.test(trimmed)) return Number.parseInt(trimmed.slice(2), 16) >>> 0;
  if (/^-?\d+$/u.test(trimmed)) return Number.parseInt(trimmed, 10) >>> 0;
  return hashLabel(trimmed);
}

/**
 * Resolves the active simulation seed. When `DADS_DST_SEED` is present in `env`,
 * it overrides any default so a failing seed can be replayed directly from the shell.
 */
export function resolveDstSeed(
  fallback: DstSeedInput = 1,
  env: NodeJS.ProcessEnv = process.env,
): { readonly seed: number; readonly fromEnv: boolean } {
  const fromEnvRaw = env["DADS_DST_SEED"];
  if (fromEnvRaw !== undefined && fromEnvRaw.trim().length > 0) {
    return { seed: parseSeed(fromEnvRaw), fromEnv: true };
  }
  return { seed: parseSeed(fallback), fromEnv: false };
}

export function createSeededRng(input: DstSeedInput): SeededRng {
  const seed = parseSeed(input);
  let state = seed;

  const nextUint32 = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return (mixed ^ (mixed >>> 14)) >>> 0;
  };

  const nextFloat = (): number => nextUint32() / 0x1_0000_0000;

  const int = (minInclusive: number, maxInclusive: number): number => {
    if (!Number.isInteger(minInclusive) || !Number.isInteger(maxInclusive) || maxInclusive < minInclusive) {
      throw new Error(`Invalid int range [${String(minInclusive)}, ${String(maxInclusive)}].`);
    }
    const span = maxInclusive - minInclusive + 1;
    return minInclusive + Math.floor(nextFloat() * span);
  };

  const bool = (probability = 0.5): boolean => {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error(`Probability must be between 0 and 1; got ${String(probability)}.`);
    }
    return nextFloat() < probability;
  };

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error("Cannot pick from an empty array.");
    const chosen = items[int(0, items.length - 1)];
    if (chosen === undefined) throw new Error("Unexpected empty slot during RNG pick.");
    return chosen;
  };

  const shuffle = <T>(items: readonly T[]): T[] => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = int(0, i);
      const a = copy[i];
      const b = copy[j];
      if (a !== undefined && b !== undefined) {
        copy[i] = b;
        copy[j] = a;
      }
    }
    return copy;
  };

  const bytes = (length: number): Uint8Array => {
    if (!Number.isInteger(length) || length < 0) {
      throw new Error(`Byte length must be a non-negative integer; got ${String(length)}.`);
    }
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      out[i] = nextUint32() & 0xff;
    }
    return out;
  };

  const fork = (label: string): SeededRng => createSeededRng((seed ^ hashLabel(label)) >>> 0);

  return { seed, nextFloat, int, bool, pick, shuffle, bytes, fork };
}

function hashLabel(label: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < label.length; i += 1) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
