/**
 * Which authorization warnings become a recorded fault, and how often.
 *
 * The authorization guards note a warning on the request tally every time a
 * lookup passes its mark or a request passes its round-trip budget. One hot
 * caller on a busy list would note it on every request, and a fault row per
 * request is how an alert becomes noise. So a warning is recorded at most once
 * per hour per (warning, route): the fingerprint of the recorded fault names
 * both, so two routes listing the same type are two faults, and the
 * fault-alert sweep groups each by its fingerprint.
 *
 * One instance per HTTP app, in memory: with several API processes each
 * records its own once an hour, which is still a handful of rows an hour.
 */

import type { AuthorizationWarning } from "@dads-framework/runtime/request-work";

const ONE_HOUR_MS = 60 * 60 * 1000;

/** The fault a warning is recorded as: an exception type and fingerprint. */
export type RecordedWarningFault = {
  readonly type: string;
  readonly fingerprint: string;
};

export class AuthorizationWarningFaults {
  readonly #lastRecordedAt = new Map<string, number>();
  readonly #intervalMs: number;

  constructor(intervalMs: number = ONE_HOUR_MS) {
    this.#intervalMs = intervalMs;
  }

  /**
   * The fault to record for `warning` on `routePattern` now, or `undefined`
   * when the same fault was recorded within the interval.
   */
  recordable(
    warning: AuthorizationWarning,
    routePattern: string | undefined,
    nowMs: number,
  ): RecordedWarningFault | undefined {
    const fingerprint = `${warning.fingerprint}@${routePattern ?? "unmatched"}`;
    const last = this.#lastRecordedAt.get(fingerprint);
    if (last !== undefined && nowMs - last < this.#intervalMs) return undefined;
    this.#lastRecordedAt.set(fingerprint, nowMs);
    return { type: warning.type, fingerprint };
  }
}
