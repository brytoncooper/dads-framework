# @dads-framework/client-telemetry-core

Accept `ClientTelemetry` to report client errors and breadcrumbs. Use
`NoneClientTelemetry` when the application has no recorder. Choose an HTTP or
vendor implementation with
[`@dads-framework/client-telemetry`](../telemetry/README.md).

## Try it

Install the port in a TypeScript project that reports client failures.

```sh
npm install @dads-framework/client-telemetry-core
```

Use the recording fake in a test to see what a render-failure handler sends
through the port. The example uses Node.js 22 or later.

<!-- dads:check-example -->

```ts
import type { ClientTelemetry } from "@dads-framework/client-telemetry-core";
import { FakeClientTelemetry } from "@dads-framework/client-telemetry-core/testing";

function reportRenderFailure(telemetry: ClientTelemetry, error: unknown): void {
  telemetry.reportError(error, { kind: "render" });
}

const telemetry = new FakeClientTelemetry();
reportRenderFailure(telemetry, new Error("Could not render inventory"));

console.log(telemetry.reported.map(({ context }) => context.kind));
```

The console shows an array containing `render`. The application supplies
`NoneClientTelemetry` when recording is disabled or a configured recorder
when enabled.

## Provider contract

Reporting is synchronous and cannot throw. `flush(timeoutMs)` resolves
`true` when delivery completes and `false` on failure or timeout. Import
the in-memory recorder and shared provider laws from
`@dads-framework/client-telemetry-core/testing`.
