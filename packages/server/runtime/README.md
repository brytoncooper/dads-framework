# `@dads-framework/runtime`

Provides injectable clocks, request work accounting, and server fault reporting.

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
console.log(dueAt(fixed, 60_000).toISOString());
```

The script prints `2026-01-01T00:01:00.000Z`.

## Use it

| Import                                         | Use                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `@dads-framework/runtime/clock`                | Inject a `Clock` so callers can supply system or fixed time. This entry point works in browsers. [Clock examples](./clock/README.md) |
| `@dads-framework/runtime/request-work`         | Start a request tally and charge database queries and authorization checks. [Request work examples](./request-work/README.md)        |
| `@dads-framework/runtime/request-work/testing` | Start a tally around a test callback with `measureRequestWork`.                                                                      |
| `@dads-framework/runtime/diagnostics`          | Capture exceptions with a consistent fingerprint using `createDiagnosticsReporter`. [Diagnostics examples](./diagnostics/README.md)  |
| `@dads-framework/runtime/diagnostics/testing`  | Record captured exceptions with `FakeDiagnosticsReporter`.                                                                           |

Request work and diagnostics use Node.js APIs.

## What it refuses to do

Request work tracks the cost of calls inside the current request. The HTTP app owns request deadlines and shutdown. Diagnostics sends a fingerprint and selected exception details. Application composition owns reporter configuration and shutdown.

## Contract

- `Clock.now()` returns a `Date`. Use a monotonic clock for elapsed time.
- Request work charges successful and failed calls and leaves each call's result or error intact.
- `DiagnosticsReporter.captureException()` returns `void` and never throws. Call `flush(timeoutMs)` to wait for buffered reports and `close()` during shutdown.
