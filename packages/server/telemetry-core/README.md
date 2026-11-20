# `@dads-framework/telemetry-core`

Correlate server spans with request records using a bounded request ID and the
audit actor's kind. Use this package at the host boundary when building a
reporter or adapter. To export Node HTTP and Postgres spans to a collector,
use [the telemetry package](../telemetry/README.md).

## Try it

Install the package.

```sh
npm install @dads-framework/telemetry-core
```

Save as `trace-attributes.mts` and run `node trace-attributes.mts` with
Node.js 22.18 or newer.

<!-- dads:check-example -->

```ts
import { requestTraceAttributes } from "@dads-framework/telemetry-core";

for (const requestId of ["order-42", "invalid request id"]) {
  console.log(
    JSON.stringify(requestTraceAttributes({ requestId, actorKind: "user" })),
  );
}
```

The first line contains `"dads.audit.actor.kind":"user"` and
`"dads.request.id":"order-42"`. The second line contains only the actor kind
because the request ID includes spaces.

The repo’s telemetry adapter calls this helper in
[`packages/server/telemetry/src/trace-request.ts`](../telemetry/src/trace-request.ts) to add attributes
to the active span. The generated starter connects that adapter in
[`assembly/start-app.ts`](../../../apps/kit-workbench/assembly/start-app.ts).

## Contract

`requestTraceAttributes` accepts the two facts a server has resolved for its
request. It emits the actor kind and includes the request ID when it matches
the correlation-token format. A request ID that contains whitespace or exceeds
128 characters is omitted.

The `testing` entry point supplies an in-memory recorder and the same
attribution cases used to verify the OTLP adapter.
