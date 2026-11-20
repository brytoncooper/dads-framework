# `@dads-framework/telemetry`

Trace an HTTP request through its Postgres calls and use the request ID to
find the matching server record. The process starts without tracing if no
exporter endpoint is configured.

## Try it

Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` for a local collector. Initialize telemetry before loading HTTP or Postgres.

```ts
import { startTelemetry } from "@dads-framework/telemetry";

const telemetry = await startTelemetry({ serviceName: "example-api" });
try {
  const { createHttpApp } = await import("@dads-framework/http");
  const app = await createHttpApp({
    nodeEnv: "production",
    trustedOrigins: [],
    ...(telemetry === undefined
      ? {}
      : {
          currentTraceId: telemetry.currentTraceId,
          requestTrace: telemetry.annotateRequest,
        }),
  });
  try {
    await app.listen({ host: "127.0.0.1" });
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
  } finally {
    await app.close();
  }
} finally {
  await telemetry?.shutdown();
}
```

## Configure it

Use the standard OTLP HTTP/protobuf variables. `OTEL_EXPORTER_OTLP_ENDPOINT` is the base URL. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` takes precedence and must include the trace path. The exporter supports standard OTLP headers and timeouts; `OTEL_SERVICE_NAME` can override the application's service name, and `OTEL_RESOURCE_ATTRIBUTES` adds resource metadata. `OTEL_SDK_DISABLED=true` or `OTEL_TRACES_EXPORTER=none` disables tracing.

## Contract

Start one telemetry runtime per process before evaluating HTTP and Postgres modules. Keep `pg` external when bundling. Close listeners and database pools before calling `shutdown()` so the SDK can flush the final batch.

Trace export includes HTTP method and status, Postgres spans, bounded request correlation IDs, and audit actor kinds. The exporter excludes request and response headers, URL paths and queries, SQL text and arguments, actor IDs and commentary, and exception details. Configure resource attributes with deployment metadata suitable for your collector.

Run `bash packages/server/telemetry/proof/verify-local-collector.sh` after building the workspace to exercise real HTTP and Postgres spans against a local collector. The proof uses Docker and cleans up its containers.
