import type { RateLimitCapability } from "../route/capabilities.js";

/**
 * The rate-limit engine: a fixed-window counter per (route, caller),
 * per-replica. Deliberately simple — the window resets on the minute
 * boundary; a distributed limiter (Redis) is the upgrade path when
 * multi-instance deploys arrive, behind this same capability field.
 */

type Window = { count: number; resetAtMs: number };

const WINDOW_MS = 60_000;

export type RateLimiter = {
  /** True when the caller still has budget; counts the request. */
  readonly consume: (routeKey: string, callerKey: string) => RateVerdict;
  /** Callers currently tracked — bounded by eviction; for tests and metrics. */
  readonly size: () => number;
};

export type RateVerdict = { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export function createRateLimiter(limit: Exclude<RateLimitCapability, "unlimited">, now: () => number): RateLimiter {
  const windows = new Map<string, Window>();
  let nextSweepAtMs = 0;

  // Without eviction, every distinct caller ever seen lives in the map for
  // the replica's lifetime — a churning-IP flood becomes unbounded memory
  // growth. One sweep per window keeps the map bounded by a single window's
  // distinct callers, at O(entries) once a minute.
  function sweepExpiredWindows(at: number): void {
    if (at < nextSweepAtMs) return;
    nextSweepAtMs = at + WINDOW_MS;
    for (const [key, window] of windows) {
      if (window.resetAtMs <= at) windows.delete(key);
    }
  }

  return {
    size: () => windows.size,
    consume: (routeKey, callerKey) => {
      const key = `${routeKey}\u0000${callerKey}`;
      const at = now();
      sweepExpiredWindows(at);
      const window = windows.get(key);
      if (!window || window.resetAtMs <= at) {
        windows.set(key, { count: 1, resetAtMs: at + WINDOW_MS });
        return { allowed: true };
      }
      if (window.count < limit.perMinute) {
        window.count += 1;
        return { allowed: true };
      }
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((window.resetAtMs - at) / 1000)),
      };
    },
  };
}
