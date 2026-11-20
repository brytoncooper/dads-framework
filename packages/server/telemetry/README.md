# `@dads-framework/telemetry`

Trace an HTTP request through its Postgres calls and use the request ID to
find the matching server record. The process starts without tracing if no
exporter endpoint is configured.

## Try it

Install the telemetry adapter. Start a local OTLP HTTP collector with a
debug exporter on port 4318.

```sh
npm install @dads-framework/telemetry \
  @opentelemetry/api @opentelemetry/exporter-trace-otlp-proto \
  @opentelemetry/instrumentation @opentelemetry/instrumentation-http \
  @opentelemetry/instrumentation-pg @opentelemetry/resources \
  @opentelemetry/sdk-node @opentelemetry/sdk-trace
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
```

Save as `trace-request.mts` and run `node trace-request.mts` with Node.js
22.18 or newer. The script initializes telemetry before loading Node HTTP.

<!-- dads:check-example -->

```ts
import { startTelemetry } from "@dads-framework/telemetry";

const telemetry = await startTelemetry({ serviceName: "example-api" });
if (telemetry === undefined) {
  console.log("Telemetry disabled");
} else {
  const { createServer } = await import("node:http");
  const server = createServer((_request, response) => {
    telemetry.annotateRequest({
      requestId: "example-1",
      actorKind: "anonymous",
    });
    response.end("ready");
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a loopback TCP address");
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/ready`);
    console.log(response.status, await response.text());
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await telemetry.shutdown();
  }
}
```

The script prints `200 ready`. The collector receives a server span for
`example-api` with request ID `example-1` and actor kind `anonymous`.
Without an exporter endpoint, the script prints `Telemetry disabled`.

The generated starter starts telemetry in [`assembly/main.ts`](../../../apps/kit-workbench/assembly/main.ts) before
loading the HTTP host. [`assembly/start-app.ts`](../../../apps/kit-workbench/assembly/start-app.ts) supplies the request
attribution hook to the HTTP kit.

## Use it

The optional OpenTelemetry peers are needed when starting the configured exporter. The package root can start with tracing disabled without those peers.

Use `@dads-framework/telemetry/core` for vendor-independent request attribution.

<!-- dads:check-example -->

```ts
import { requestTraceAttributes } from "@dads-framework/telemetry/core";

console.log(
  requestTraceAttributes({ requestId: "order-42", actorKind: "user" }),
);
```

The returned attributes contain the actor kind and the request ID. IDs with whitespace or more than 128 characters are omitted. Import the in-memory recorder and shared attribution cases from `@dads-framework/telemetry/testing`.

### Configure it

Use the standard OTLP HTTP/protobuf variables. `OTEL_EXPORTER_OTLP_ENDPOINT` is the base URL. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` takes precedence and must include the trace path. The exporter supports standard OTLP headers and timeouts; `OTEL_SERVICE_NAME` can override the application's service name, and `OTEL_RESOURCE_ATTRIBUTES` adds resource metadata. `OTEL_SDK_DISABLED=true` or `OTEL_TRACES_EXPORTER=none` disables tracing.

## What it refuses to do

The exporter excludes request and response headers, URL paths and queries, SQL text and arguments, actor IDs and commentary, and exception details.

## Contract

Start one telemetry runtime per process before evaluating HTTP and Postgres modules. Keep `pg` external when bundling. Close listeners and database pools before calling `shutdown()` so the SDK can flush the final batch.

Trace export includes HTTP method and status, Postgres spans, bounded request correlation IDs, and audit actor kinds. Configure resource attributes with deployment metadata suitable for your collector.

Run `bash packages/server/telemetry/proof/verify-local-collector.sh` after building the workspace to exercise real HTTP and Postgres spans against a local collector. The proof uses Docker and cleans up its containers.
