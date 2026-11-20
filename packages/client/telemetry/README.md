# `@dads-framework/client-telemetry`

Where a client reports a fault that never became a request: a render that
threw, a rejected promise, a chunk that would not load, a response that did
not match the contract the client compiled against.

Request logs cover traffic the server receives. Browser fault reports cover
failures that happen before a request can be made or after its response
reaches the page.

## Try it

Install the reporter in a browser app. Vite supports the `local` and `none`
drivers from the package root with neither Sentry nor React installed.

```sh
npm install @dads-framework/client-telemetry
```

Connect `POST /api/client-diagnostics` to your same-origin diagnostics
receiver. The [audit package](../../server/audit/README.md) describes the
server-side receiver. Run this once in a development build to check delivery.

<!-- dads:check-example -->

```ts
import { createClientTelemetry } from "@dads-framework/client-telemetry";

const telemetry = createClientTelemetry({
  driver: "local",
  endpoint: "/api/client-diagnostics",
  release: "web-1.0.0",
});

telemetry.reportError(new Error("Example render failure"), { kind: "render" });
console.log(await telemetry.flush(2_000));
```

The browser Network panel shows a POST containing one render fault. The
console prints `true` if the receiver accepts it within two seconds. In the app,
use your build identifier for `release` and call `reportError` from the failure
handler.

The [local reporter tests](src/lib/local-client-telemetry.test.ts) flush a
render error through an injected fetch function and validate the outgoing
diagnostics payload.

## Use it

Import `ClientTelemetry`, `NoneClientTelemetry`, and their context and breadcrumb types from `@dads-framework/client-telemetry/core`. This subpath works in plain TypeScript projects without Sentry or React.

<!-- dads:check-example -->

```ts
import type { ClientTelemetry } from "@dads-framework/client-telemetry/core";
import { FakeClientTelemetry } from "@dads-framework/client-telemetry/testing";

function reportRenderFailure(telemetry: ClientTelemetry, error: unknown): void {
  telemetry.reportError(error, { kind: "render" });
}

const telemetry = new FakeClientTelemetry();
reportRenderFailure(telemetry, new Error("Could not render inventory"));
console.log(telemetry.reported.map(({ context }) => context.kind));
```

The console shows an array containing `render`. The testing subpath also exports `clientTelemetryConformance` to verify a provider.

### The seam

`ClientTelemetry` names three things and no vendor: `reportError`,
`addBreadcrumb`, `flush`. Reporting returns `void` and never throws, because
every caller is already inside a failure and none of them can afford a second
one.

There is deliberately no `identify`. Who the user is comes from the session
the server already resolved, so the browser never asserts an identity and no
principal data has to live here.

### Drivers

| Driver             | Reports to                                                         | When to use it                              |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------- |
| `none`             | No destination                                                     | Local or offline use                        |
| `local`            | The configured same-origin diagnostics endpoint                    | Keep browser faults in the application      |
| `local-and-vendor` | The application endpoint and a vendor through a same-origin tunnel | Keep the app record and also forward faults |

Install the optional `@sentry/react` peer for the built-in vendor driver.
The vendor configuration requires a DSN, tunnel path, and environment.
The caller still uses the same `ClientTelemetry` surface.

## What it refuses to do

`shouldReportFailure` is the judgement, and it is a pure function with its own
tests because it is what keeps this from becoming noise. Faults are reported;
refusals are not. A 4xx is the API working, an expired session is already
handled, and intermittent connectivity is expected.

See the [audit package](../../server/audit/README.md) for the server-side
request log and diagnostics receiver.

## Contract

`reportError` and `addBreadcrumb` are synchronous and never throw. `flush(timeoutMs)` resolves `true` when delivery completes and `false` on failure or timeout. The local driver requires an endpoint and a release. The built-in vendor driver loads Sentry when the vendor reporter is constructed.
