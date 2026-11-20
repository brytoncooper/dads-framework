/**
 * When a relationship write that SpiceDB did not accept is worth sending again.
 *
 * Concurrent writes to one datastore can lose a race inside SpiceDB: the
 * in-memory datastore answers `DEADLINE_EXCEEDED: serialization max retries
 * exceeded`, and the SQL datastores answer `ABORTED` on a serialization
 * conflict. Neither is a refusal — the same write succeeds a moment later.
 * Every write this adapter sends is idempotent (relationship writes TOUCH,
 * deletes of absent tuples are no-ops), so sending it again is safe.
 *
 * Without this, a lost race was terminal for the caller. A resource created during concurrent writes could return success
 * with its ownership fact still pending.
 *
 * A refusal (`FAILED_PRECONDITION`, `INVALID_ARGUMENT`, …) is never retried:
 * it will be refused again, and the caller must hear it once.
 */

/** gRPC status codes for a write that lost a race rather than one SpiceDB refused. */
const RETRYABLE_WRITE_STATUS_CODES: ReadonlySet<number> = new Set([
  4, // DEADLINE_EXCEEDED — memdb serialization retries exhausted
  10, // ABORTED — SQL datastore serialization conflict
  14, // UNAVAILABLE — connection dropped before an answer
]);

/** Total sends of one write, the first included. */
export const SPICE_DB_WRITE_ATTEMPTS = 4;

export function isRetryableSpiceDbWriteError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return (
    typeof error.code === "number" &&
    RETRYABLE_WRITE_STATUS_CODES.has(error.code)
  );
}

/** Back off 10, 20, 40 ms: long enough for the competing write to commit. */
export function spiceDbWriteRetryDelayMs(failedAttempt: number): number {
  return 10 * 2 ** (failedAttempt - 1);
}
