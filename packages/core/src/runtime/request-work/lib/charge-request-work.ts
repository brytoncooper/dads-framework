/**
 * The two call sites' side of the tally: time a call, charge it, and be
 * otherwise invisible.
 *
 * Wrappers rather than a `count(ms)` call at each seam, so `performance.now()`
 * appears once and every counted call obeys the same two rules:
 *
 * - **A failure is charged too.** A statement that took 800ms and then threw
 *   cost the request 800ms. Dropping it would make the slowest requests — the
 *   ones being investigated — look the cheapest.
 * - **The caller's outcome is untouched.** The value is returned and the
 *   rejection rethrown exactly as they arrived. A tally that changed an error
 *   would be a tally nobody could trust in a stack trace.
 *
 * `performance.now()` is monotonic and unaffected by clock adjustment, which
 * is what an elapsed measurement needs; the `Clock` seam answers "what time is
 * it", which is a different question and not this one.
 */

import {
  countAuthorizationCheck,
  countDatabaseQuery,
} from "./request-work-tally.js";

/** Charges one database statement to the current request, if there is one. */
export async function chargeDatabaseQuery<T>(
  work: () => Promise<T> | T,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    countDatabaseQuery(performance.now() - startedAt);
  }
}

/** Charges one authorization call to the current request, if there is one. */
export async function chargeAuthorizationCheck<T>(
  work: () => Promise<T> | T,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    countAuthorizationCheck(performance.now() - startedAt);
  }
}
