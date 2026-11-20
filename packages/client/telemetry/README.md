# `@dads-framework/client-telemetry`

Where a client reports a fault that never became a request: a render that
threw, a rejected promise, a chunk that would not load, a response that did
not match the contract the client compiled against.

Request logs cover traffic the server receives. Browser fault reports cover
failures that happen before a request can be made or after its response
reaches the page.

## Try it

Configure the reporter at browser startup. The app must serve the selected
same-origin endpoint.

```ts
import { createClientTelemetry } from "@dads-framework/client-telemetry";

const telemetry = createClientTelemetry({
  driver: "local",
  endpoint: "/api/client-diagnostics",
  release: "web-1.0.0",
});

telemetry.reportError(new Error("Example render failure"), { kind: "render" });
const delivered = await telemetry.flush(2_000);
```

Use a build identifier for `release`. A successful flush hands the buffered
events to the configured destination.

## The seam

`ClientTelemetry` names three things and no vendor: `reportError`,
`addBreadcrumb`, `flush`. Reporting returns `void` and never throws, because
every caller is already inside a failure and none of them can afford a second
one.

There is deliberately no `identify`. Who the user is comes from the session
the server already resolved, so the browser never asserts an identity and no
principal data has to live here.

## Drivers

| Driver             | Reports to                                                         | When to use it                              |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------- |
| `none`             | No destination                                                     | Local or offline use                        |
| `local`            | The configured same-origin diagnostics endpoint                    | Keep browser faults in the application      |
| `local-and-vendor` | The application endpoint and a vendor through a same-origin tunnel | Keep the app record and also forward faults |

The vendor configuration requires a DSN, tunnel path, and environment.
The caller still uses the same `ClientTelemetry` surface.

## What gets reported

`shouldReportFailure` is the judgement, and it is a pure function with its own
tests because it is what keeps this from becoming noise. Faults are reported;
refusals are not. A 4xx is the API working, an expired session is already
handled, and intermittent connectivity is expected.

See the [audit package](../../server/audit/README.md) for the server-side
request log and diagnostics receiver.

The fault reporting contract lives in
[`@dads-framework/client-telemetry-core`](../telemetry-core/README.md). The
package re-exports it and runs shared conformance against the Sentry driver.
