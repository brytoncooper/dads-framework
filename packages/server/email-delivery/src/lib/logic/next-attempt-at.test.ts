/**
 * The backoff schedule is the retry engine (INV-EMAILDELIVERY-3): the jobs
 * run once and the row decides whether there is a next time, so these numbers
 * are the whole policy and are pinned rather than described.
 */
import { describe, expect, it } from "vitest";
import { MAX_DELIVERY_ATTEMPTS, nextAttemptAt } from "./next-attempt-at.js";

const NOW = new Date("2026-09-11T12:00:00.000Z");

function secondsAfterNow(at: Date | null): number | null {
  return at === null ? null : (at.getTime() - NOW.getTime()) / 1000;
}

describe("nextAttemptAt", () => {
  it("doubles the wait from thirty seconds after each failed attempt", () => {
    expect(secondsAfterNow(nextAttemptAt(1, NOW))).toBe(30);
    expect(secondsAfterNow(nextAttemptAt(2, NOW))).toBe(60);
    expect(secondsAfterNow(nextAttemptAt(3, NOW))).toBe(120);
    expect(secondsAfterNow(nextAttemptAt(4, NOW))).toBe(240);
  });

  it("gives up after the last allowed attempt", () => {
    expect(nextAttemptAt(MAX_DELIVERY_ATTEMPTS, NOW)).toBeNull();
    expect(nextAttemptAt(MAX_DELIVERY_ATTEMPTS + 1, NOW)).toBeNull();
  });

  it("never waits longer than ten minutes", () => {
    // Reached only if MAX_DELIVERY_ATTEMPTS is raised; the ceiling is what
    // keeps a raised limit from turning into an hours-long tail.
    expect(secondsAfterNow(nextAttemptAt(20, NOW, 25))).toBe(600);
  });

  it("refuses an attempt number that never happened", () => {
    expect(() => nextAttemptAt(0, NOW)).toThrow(/attempt/);
  });
});
