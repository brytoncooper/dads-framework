import type { Clock } from "./clock.js";
import { SystemClock } from "./clock.js";

/** The system clock — the plain-factory form of ClockModule. */
export function createClock(): Clock {
  return new SystemClock();
}
