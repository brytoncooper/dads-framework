/** Duration accepted by test clocks and expiring grants (ms or `"30m"`, `"2h"`, `"7d"`). */
export type TestDuration =
  | number
  | `${number}ms`
  | `${number}s`
  | `${number}m`
  | `${number}h`
  | `${number}d`;

const DURATION_UNITS_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

/** Parse a `TestDuration` into non-negative milliseconds. */
export function parseTestDurationMs(duration: TestDuration): number {
  if (typeof duration === "number") {
    if (!Number.isFinite(duration) || duration < 0) {
      throw new Error(`Invalid test duration: ${String(duration)}ms`);
    }
    return Math.round(duration);
  }
  const match = DURATION_PATTERN.exec(duration.trim());
  if (match === null) {
    throw new Error(
      `Invalid test duration "${duration}". Use milliseconds or a suffix like "500ms", "30s", "15m", "1h", "7d".`,
    );
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multiplier = DURATION_UNITS_MS[unit] ?? 1;
  return Math.round(amount * multiplier);
}

/** Format a positive millisecond delta into a compact human-readable label. */
export function formatRelativeDuration(deltaMs: number): string {
  const absoluteMs = Math.max(0, Math.round(deltaMs));
  if (absoluteMs < 1_000) return `${String(absoluteMs)}ms`;
  const totalSeconds = Math.floor(absoluteMs / 1_000);
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return remainingSeconds === 0
      ? `${String(totalMinutes)}m`
      : `${String(totalMinutes)}m ${String(remainingSeconds)}s`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  if (totalHours < 24) {
    return remainingMinutes === 0
      ? `${String(totalHours)}h`
      : `${String(totalHours)}h ${String(remainingMinutes)}m`;
  }
  const totalDays = Math.floor(totalHours / 24);
  const remainingHours = totalHours % 24;
  return remainingHours === 0
    ? `${String(totalDays)}d`
    : `${String(totalDays)}d ${String(remainingHours)}h`;
}

/** Deterministic clock for testing expiring relationships without real timers. */
export class ControllableClock {
  private currentMs: number;

  constructor(initialTime: Date | number = Date.UTC(2026, 0, 1, 0, 0, 0)) {
    this.currentMs =
      initialTime instanceof Date ? initialTime.getTime() : initialTime;
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  nowMs(): number {
    return this.currentMs;
  }

  advance(duration: TestDuration): Date {
    this.currentMs += parseTestDurationMs(duration);
    return this.now();
  }

  set(nextTime: Date | number): Date {
    this.currentMs = nextTime instanceof Date ? nextTime.getTime() : nextTime;
    return this.now();
  }
}
