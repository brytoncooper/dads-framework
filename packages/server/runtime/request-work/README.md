# `@dads-framework/runtime/request-work`

Per-request work accounting: how many database statements and authorization
checks one request cost, and how long it spent inside them.

`request_log.duration_ms` already says a request took 900ms. This is the
missing half — the columns that say whether that was three slow queries or
three hundred fast ones, which is the difference between a tuning problem and
an N+1.

## Why it is a leaf

Both counters live at seams that must not depend on the HTTP kit: the
attributed pool in `@dads-framework/postgres` and the `Authorization` port in
`@dads-framework/authorization`. This library imports nothing of ours, so both can
charge into it and `@dads-framework/http` can read the result back out.

## How it is used

| Seam                                             | Call                                                   |
| ------------------------------------------------ | ------------------------------------------------------ |
| HTTP ingress (`createHttpApp`'s `onRequest`)     | `beginRequestWork(request)`                            |
| Pooled connection checkout (`AttributedPool`)    | `chargeDatabaseQuery(() => client.query(...))`         |
| Authorization port (`TalliedAuthorization`)      | `chargeAuthorizationCheck(() => inner.check(...))`     |
| Capture (`captureRequestRecord` at `onResponse`) | `requestWorkOf(request)`                               |
| Tests                                            | `measureRequestWork(work)` from the `/testing` subpath |

## Rules it keeps

- Nothing here can fail a request. A counter with no tally in context returns
  without doing anything.
- A failed call is charged. A statement that took 800ms and then threw cost the
  request 800ms; dropping it would make the slowest requests look cheapest.
- Work outside a request — jobs, the request-log sink's own flush, migrations —
  is counted nowhere. It is not a request's cost.

Use the [HTTP package](../../http/README.md) to attach the tally to request records.

## Try it

In a Node.js 22+ project, install the package.

```sh
npm install @dads-framework/runtime
```

Save this as `example.mts` and run `node --experimental-strip-types example.mts`.

<!-- dads:check-example -->

```ts
import { chargeDatabaseQuery } from "@dads-framework/runtime/request-work";
import { measureRequestWork } from "@dads-framework/runtime/request-work/testing";

const tally = await measureRequestWork(() =>
  chargeDatabaseQuery(() => Promise.resolve("query result")),
);
console.log(tally.dbQueryCount); // 1
```

The script prints `1` for one charged database call. The test helper
starts the request tally without an HTTP server.

The HTTP package starts a tally for each incoming request. The attributed
Postgres client charges its queries to that tally.
[HTTP ingress](../../http/src/lib/create-http-app.ts) · [Attributed query wrapper](../../postgres/src/lib/counting-client.ts)

## What it refuses to do

This package tracks request-scoped work. An HTTP app owns timeouts and decides when to finish or shut down outstanding work.
