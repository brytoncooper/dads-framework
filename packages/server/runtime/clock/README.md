# @dads-framework/runtime/clock — time as a seam

The `Clock` abstract class and its system implementation. Anything that
needs "now" takes a `Clock` in its constructor, so tests inject fixed time
and logic never reaches for `Date.now()` ambiently.

## Try it

In a Node.js 22+ project, install the package.

```sh
npm install @dads-framework/runtime
```

Save this as `example.mts` and run `node --experimental-strip-types example.mts`.

<!-- dads:check-example -->

```ts
import { type Clock } from "@dads-framework/runtime/clock";

function dueAt(clock: Clock, delayMs: number) {
  return new Date(clock.now().getTime() + delayMs);
}

const fixed = { now: () => new Date("2026-01-01T00:00:00Z") };
console.log(dueAt(fixed, 60_000).toISOString()); // 2026-01-01T00:01:00.000Z
```

The script prints `2026-01-01T00:01:00.000Z`. Use `createClock()` in
application wiring and give tests a fixed `now()`. Durations and elapsed-time
performance measurements belong to a monotonic clock.

In the generated app, `assembly/local-mail.ts` supplies a system clock
to email delivery and its jobs. [Starter mail wiring](../../../../apps/kit-workbench/assembly/local-mail.ts)

## What it refuses to do

The clock supplies wall time. Use a monotonic clock for elapsed time.
