import type { DomainError } from "./domain-error.js";

/**
 * Explicit success/failure for expected command outcomes
 * (docs/architecture/type-safety.md#5). If a caller would reasonably `catch`
 * and branch, the operation should return a `Result`; exceptions remain for
 * unexpected faults where the only sane response is a 500 and a log line.
 */
export type Result<T, E = DomainError> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

export function err<E>(error: E): { readonly ok: false; readonly error: E } {
  return { ok: false, error };
}

/** Unwraps a Result, throwing the typed error — the HTTP edge's bridge to the global filter. */
export function unwrap<T, E extends Error>(result: Result<T, E>): T {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
