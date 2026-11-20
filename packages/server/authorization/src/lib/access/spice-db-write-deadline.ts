/**
 * How long one relationship write may take before it is abandoned.
 *
 * Writes run one at a time, so a write that never answers (a half-open
 * connection, a hung SpiceDB) would hold every later write behind it. A
 * relationship write is a handful of tuples and normally answers in
 * milliseconds; ten seconds is far past that and still short enough that a
 * stuck write frees the queue before a request's own deadline.
 *
 * The SDK's 30 s default deadline is not applied to the permissions service
 * it preconnects, so without this a relationship write has no deadline at all
 * (`spice-db-clients.ts` gives the write channel one).
 */
export const RELATIONSHIP_WRITE_DEADLINE_MS = 10_000;

/** A schema write validates the whole schema; it gets the SDK's own 30 s. */
export const SCHEMA_WRITE_DEADLINE_MS = 30_000;

/**
 * Past the gRPC deadline, how long the adapter waits for the call to report
 * it before giving up on it itself — the backstop for a transport that never
 * delivers even its own deadline error.
 */
const BACKSTOP_GRACE_MS = 1_000;

/**
 * Rejects when `send` has not settled within the deadline plus a grace, so
 * the write queue always moves on even if the call itself never answers.
 * The rejection carries no gRPC status code, so it is never retried.
 */
export function withinWriteDeadline<T>(
  send: () => Promise<T>,
  deadlineMs: number,
): Promise<T> {
  const limitMs = deadlineMs + Math.min(BACKSTOP_GRACE_MS, deadlineMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`SpiceDB write gave no answer within ${limitMs} ms`));
    }, limitMs);
    timer.unref();
  });
  return Promise.race([send(), expired]).finally(() => {
    clearTimeout(timer);
  });
}
