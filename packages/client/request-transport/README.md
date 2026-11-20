# @dads-framework/client-request-transport

The one HTTP chokepoint for `web`. Every call the app makes to its
API goes through this lib, so the rules that must hold for all of them
— contract-validated request bodies and query strings, envelope unwrapping,
typed errors, the correlation header, cookie credentials, and the single
reaction to an expired session — are written once and cannot drift per
feature.

Nothing here knows about a resource. Per-resource clients live in sibling libs
in application domains and call its contract-aware verbs; feature libs
consume those clients and never reach for the transport directly.

`requestBinary` accepts a bound route, validated body/query arguments, request-local
headers, and an abort signal. It returns bytes and uses the same credentials,
metadata, and typed failures as JSON requests. Callers set `accept` for the
endpoint's media type; its default is `application/octet-stream`.

It also owns the two rules every write shares on its way back to the screen:
who reports a failure (`FAILURE_PRESENTED_INLINE`) and how a write is shown
before the server answers (`optimisticRecordWrite`). The optimistic helper
patches cached reads by record `id`, restores them if the write is refused,
and refetches once it settles — it knows the shape of a page, never a
resource. Pass any implementation of the `OptimisticQueryCache` contract.
The TanStack Query client already implements those operations.

Its typed errors (`ApiError`, `UnauthorizedError`, `NetworkError`) stay
instances of their own class even when a script on the page has replaced the
global `Error` with a constructor that returns its own object: each constructor
re-points the result at its class. Every "expected refusal or real fault?"
decision in the app is an `instanceof` check on them, so losing the class turns
a 409 into a reported fault. Proven by `src/lib/api-error.test.ts`.

## Stale saves

Use `saveWithRefresh({ save, refresh })` to refresh the authorized record after an HTTP 409 with `ROW_VERSION_CONFLICT`. The result separates a saved value from the latest record for draft review. Save retries remain explicit actions. See the [versioned update guide](../../../docs/architecture/stale-save.md).

## Try it

```ts
import { defineRoute } from "@dads-framework/contract";
import { getFromApi } from "@dads-framework/client-request-transport";
import { z } from "zod";

const status = defineRoute("GET", "/status", () => "/status");
await getFromApi({
  route: status.bind(),
  returns: z.object({ ok: z.boolean() }),
});
```

## What it refuses to do

The transport parses replies through the caller's schema. Application code owns rendering, retry decisions, and query-cache keys.
