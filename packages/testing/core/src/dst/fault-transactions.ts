import type { SimWorld } from "./sim-world.js";

/**
 * Fault-injecting adapters for Postgres transaction retries (`40001` / `40P01`)
 * and clock-driven token / session expiry (`expiresAt` + NTP clock jumps).
 */

export type PostgresRetryableCode = "40001" | "40P01";

export class SimulatedPostgresError extends Error {
  readonly code: PostgresRetryableCode;

  constructor(code: PostgresRetryableCode, message: string) {
    super(message);
    this.name = "SimulatedPostgresError";
    this.code = code;
  }
}

export type FaultyTransactionOptions = {
  /** Probability of injecting a `40001` serialization failure per attempt. Defaults to `0.25`. */
  readonly serializationFailureRate?: number;
  /** Probability of injecting a `40P01` deadlock per attempt. Defaults to `0.05`. */
  readonly deadlockRate?: number;
  /** Maximum attempts (initial + retries). Defaults to `4`. */
  readonly maxAttempts?: number;
  /** Simulated backoff advanced on `world.clock` per retry. Defaults to `15` ms. */
  readonly retryBackoffMs?: number;
};

export type FaultyTransactionStats = {
  readonly calls: number;
  readonly attempts: number;
  readonly injected40001: number;
  readonly injected40P01: number;
  readonly retries: number;
  readonly succeeded: number;
  readonly exhausted: number;
};

export type FaultyTransactionRunner = {
  /**
   * Runs `work(attempt)` under fault injection, retrying `40001`/`40P01` up to
   * `maxAttempts` while advancing `world.clock` by deterministic backoff.
   */
  run<Result>(work: (attempt: number) => Result | Promise<Result>): Promise<Result>;
  stats(): FaultyTransactionStats;
};

export function createFaultyTransactionRunner(
  world: SimWorld,
  options: FaultyTransactionOptions = {},
): FaultyTransactionRunner {
  const rng = world.forkRng("dst:pg-tx");
  const serializationFailureRate = options.serializationFailureRate ?? 0.25;
  const deadlockRate = options.deadlockRate ?? 0.05;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
  const retryBackoffMs = Math.max(0, options.retryBackoffMs ?? 15);

  const counters = {
    calls: 0,
    attempts: 0,
    injected40001: 0,
    injected40P01: 0,
    retries: 0,
    succeeded: 0,
    exhausted: 0,
  };

  const maybeInjectFault = (): SimulatedPostgresError | undefined => {
    const roll = rng.nextFloat();
    if (roll < serializationFailureRate) {
      counters.injected40001 += 1;
      world.record("fault:pg-40001");
      return new SimulatedPostgresError("40001", "could not serialize access due to concurrent update");
    }
    if (roll < serializationFailureRate + deadlockRate) {
      counters.injected40P01 += 1;
      world.record("fault:pg-40P01");
      return new SimulatedPostgresError("40P01", "deadlock detected");
    }
    return undefined;
  };

  const runOneAttempt = async <Result>(
    attempt: number,
    work: (attempt: number) => Result | Promise<Result>,
  ): Promise<{ readonly ok: true; readonly value: Result } | { readonly ok: false; readonly error: unknown }> => {
    const fault = maybeInjectFault();
    if (fault !== undefined) return { ok: false, error: fault };
    try {
      const value = await work(attempt);
      counters.succeeded += 1;
      return { ok: true, value };
    } catch (error: unknown) {
      if (!isRetryablePostgresError(error)) throw error;
      return { ok: false, error };
    }
  };

  const run = async <Result>(work: (attempt: number) => Result | Promise<Result>): Promise<Result> => {
    counters.calls += 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      counters.attempts += 1;
      const outcome = await runOneAttempt(attempt, work);
      if (outcome.ok) return outcome.value;
      lastError = outcome.error;
      if (attempt < maxAttempts) {
        counters.retries += 1;
        world.clock.advance(retryBackoffMs * attempt);
      }
    }
    counters.exhausted += 1;
    throw lastError;
  };

  return { run, stats: () => ({ ...counters }) };
}

export function isRetryablePostgresError(error: unknown): boolean {
  if (error instanceof SimulatedPostgresError) return true;
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = Reflect.get(error, "code");
  return code === "40001" || code === "40P01";
}

export type ExpiringTokenRecord<Payload> = {
  readonly id: string;
  readonly payload: Payload;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly revokedAtMs?: number;
};

export type ExpiringTokenStore<Payload> = {
  issue(payload: Payload, ttlMs: number): ExpiringTokenRecord<Payload>;
  verify(tokenId: string): ExpiringTokenRecord<Payload> | undefined;
  revoke(tokenId: string): boolean;
  activeCount(): number;
};

/**
 * Deterministic token/session store driven strictly by `world.clock`, making it
 * trivial to test TTL boundary conditions, forward clock jumps, and revocations.
 */
export function createExpiringTokenStore<Payload>(world: SimWorld): ExpiringTokenStore<Payload> {
  const records = new Map<string, ExpiringTokenRecord<Payload>>();

  const isActive = (record: ExpiringTokenRecord<Payload>): boolean =>
    record.revokedAtMs === undefined && world.clock.nowMs() < record.expiresAtMs;

  return {
    issue: (payload: Payload, ttlMs: number): ExpiringTokenRecord<Payload> => {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new Error(`Token TTL must be positive; got ${String(ttlMs)}.`);
      }
      const issuedAtMs = world.clock.nowMs();
      const record: ExpiringTokenRecord<Payload> = {
        id: world.nextUuidV7(),
        payload,
        issuedAtMs,
        expiresAtMs: issuedAtMs + Math.trunc(ttlMs),
      };
      records.set(record.id, record);
      world.record("token:issued", { id: record.id, expiresAtMs: record.expiresAtMs });
      return record;
    },
    verify: (tokenId: string): ExpiringTokenRecord<Payload> | undefined => {
      const record = records.get(tokenId);
      if (record === undefined || !isActive(record)) return undefined;
      return record;
    },
    revoke: (tokenId: string): boolean => {
      const existing = records.get(tokenId);
      if (existing === undefined || existing.revokedAtMs !== undefined) return false;
      records.set(tokenId, { ...existing, revokedAtMs: world.clock.nowMs() });
      world.record("token:revoked", { id: tokenId });
      return true;
    },
    activeCount: (): number => {
      let count = 0;
      for (const record of records.values()) {
        if (isActive(record)) count += 1;
      }
      return count;
    },
  };
}
