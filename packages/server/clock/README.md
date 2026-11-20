# @dads-framework/clock — time as a seam

The `Clock` abstract class and its system implementation. Anything that
needs "now" takes a `Clock` in its constructor, so tests inject fixed time
and logic never reaches for `Date.now()` ambiently.

## Try it

```ts
import { createClock, type Clock } from "@dads-framework/clock";

function dueAt(clock: Clock, delayMs: number) {
  return new Date(clock.now().getTime() + delayMs);
}

const fixed = { now: () => new Date("2026-01-01T00:00:00Z") };
console.log(dueAt(fixed, 60_000).toISOString()); // 2026-01-01T00:01:00.000Z
const systemClock = createClock();
```

Use `createClock()` in application wiring and give tests a fixed `now()`.
Durations and elapsed-time performance measurements belong to a monotonic clock.
