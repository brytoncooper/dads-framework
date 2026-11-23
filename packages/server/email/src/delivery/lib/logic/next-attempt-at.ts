/**
 * How many times one outbound email is attempted before it is left `failed`
 * for an operator. Raising it lengthens the tail, never the ceiling below.
 */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** The wait after the first failure; every later wait doubles from here. */
const FIRST_BACKOFF_MS = 30_000;

/** However far the doubling runs, no attempt waits longer than this. */
const MAX_BACKOFF_MS = 600_000;

/**
 * When the attempt that just failed should be tried again, or `null` when it
 * should not be. This is the retry engine (INV-EMAILDELIVERY-3): the jobs
 * themselves run once, so a row that gets no next time here is done.
 *
 * `attempt` is the 1-based number of the attempt that just failed — the value
 * the claim already incremented on the row.
 */
export function nextAttemptAt(attempt: number, now: Date, maxAttempts: number = MAX_DELIVERY_ATTEMPTS): Date | null {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`attempt must be a positive integer, got ${attempt}`);
  }
  if (attempt >= maxAttempts) return null;
  const waitMs = Math.min(FIRST_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return new Date(now.getTime() + waitMs);
}
