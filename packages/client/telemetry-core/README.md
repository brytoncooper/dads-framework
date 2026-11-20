# @dads-framework/client-telemetry-core

Accept `ClientTelemetry` to report client errors and breadcrumbs. Use
`NoneClientTelemetry` when the application has no recorder. Choose an HTTP or
vendor implementation with
[`@dads-framework/client-telemetry`](../telemetry/README.md).

## Try it

Use the port in a component error boundary or failure handler. A development
or test composition can supply the built-in no-op implementation.

```ts
import {
  NoneClientTelemetry,
  type ClientTelemetry,
} from "@dads-framework/client-telemetry-core";

function reportRenderFailure(telemetry: ClientTelemetry, error: unknown): void {
  telemetry.reportError(error, { kind: "render" });
}

reportRenderFailure(
  new NoneClientTelemetry(),
  new Error("Example render error"),
);
```

Selecting a configured recorder at composition keeps callers unchanged.

## Provider contract

Reporting is synchronous and cannot throw. `flush(timeoutMs)` resolves
`true` when delivery completes and `false` on failure or timeout. Import
the in-memory recorder and shared provider laws from
`@dads-framework/client-telemetry-core/testing`.
