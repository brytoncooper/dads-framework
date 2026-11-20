/**
 * What: only a job's LAST failure counts as a fault.
 * Why: the difference between "having a bad minute" and "this work is lost".
 * Reporting every retry would make one flaky job look like a hundred bugs, and
 * the off-by-one is real — BullMQ counts `attemptsMade` inclusive of the
 * attempt that just failed, so a three-attempt job is terminal at 3, not 4.
 */

import { describe, expect, it } from "vitest";

import { attemptsOf, isTerminalAttempt } from "./job-attempts.js";

describe("job attempts", () => {
  it("counts the attempt that just failed", () => {
    expect(attemptsOf({ attemptsMade: 2, opts: { attempts: 5 } })).toEqual({
      made: 2,
      allowed: 5,
    });
  });

  it("gives a job with no configured attempts exactly one", () => {
    // Defaulting to zero would make every failure look non-terminal, and
    // nothing would ever be reported.
    expect(attemptsOf({ attemptsMade: 1 })).toEqual({ made: 1, allowed: 1 });
    expect(attemptsOf({ attemptsMade: 1, opts: { attempts: 0 } })).toEqual({
      made: 1,
      allowed: 1,
    });
  });

  it("defaults a job BullMQ could not hand over", () => {
    expect(attemptsOf(undefined)).toEqual({ made: 0, allowed: 1 });
  });

  it("is not terminal while a retry remains", () => {
    expect(isTerminalAttempt({ made: 1, allowed: 3 })).toBe(false);
    expect(isTerminalAttempt({ made: 2, allowed: 3 })).toBe(false);
  });

  it("is terminal on the last attempt, not the one after it", () => {
    // The off-by-one: `attemptsMade` includes the failure being handled, so a
    // three-attempt job is done at 3. `>` instead of `>=` would never report.
    expect(isTerminalAttempt({ made: 3, allowed: 3 })).toBe(true);
  });

  it("is terminal for a single-attempt job on its first failure", () => {
    expect(isTerminalAttempt({ made: 1, allowed: 1 })).toBe(true);
  });
});
