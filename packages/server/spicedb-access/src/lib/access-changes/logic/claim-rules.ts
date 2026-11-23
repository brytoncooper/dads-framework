import type { OutboxStatus } from "../enqueue.js";

/**
 * The projector's decisions, with no database and no clock of their own.
 *
 * Claiming itself must happen in SQL — only the database can hand one row to
 * exactly one worker — so what lives here is the two judgements that surround
 * it: which rows a claim is ALLOWED to take, expressed as the cutoff its WHERE
 * compares against, and what becomes of a row whose projection just failed.
 * Both are the kind of arithmetic that is wrong in production and untestable
 * there.
 */

/** How long a worker may hold a claimed row before another may steal it. */
export const DEFAULT_LEASE_MS = 60_000;

/**
 * Give up after this many failures and leave the row for a human. The count is
 * deliberately small: a fact that has failed five times is not going to
 * succeed on the sixth, and a row retried forever is a queue that never drains
 * and an alert nobody sees.
 */
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * A row locked at or before this instant has an expired lease and may be
 * re-claimed. This is what stops a crashed worker parking a fact forever: the
 * worker is gone, its lock is stale, and the next run takes the row back.
 */
export function leaseCutoff(now: Date, leaseMs: number = DEFAULT_LEASE_MS): Date {
  return new Date(now.getTime() - leaseMs);
}

/**
 * A failure settles a row as retryable or spent — never as PROJECTED, which is
 * why the type is narrower than `OutboxStatus`.
 */
export type FailureOutcome = {
  readonly status: Extract<OutboxStatus, "PENDING" | "FAILED">;
  readonly attempts: number;
};

/**
 * What a failed projection does to its row. Below the limit it goes back to
 * PENDING with its lock released, so the next run picks it up; at the limit it
 * becomes FAILED and stays visible, because a fact that cannot be projected is
 * a human's problem and a silent drop would be a permission that quietly never
 * arrived.
 */
export function outcomeAfterFailure(
  attemptsBefore: number,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): FailureOutcome {
  const attempts = attemptsBefore + 1;
  return { status: attempts >= maxAttempts ? "FAILED" : "PENDING", attempts };
}

/**
 * Trim an adapter's error to something a `last_error` column and a human can
 * both hold. Never widened into structured diagnostics: this column exists to
 * say what went wrong at a glance, and the projector's logs hold the rest.
 */
export function summarizeError(error: unknown, maxLength = 500): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= maxLength ? message : `${message.slice(0, maxLength - 1)}…`;
}
