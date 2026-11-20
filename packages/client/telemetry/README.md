# `@dads-framework/client-telemetry`

Where a client reports a fault that never became a request: a render that
threw, a rejected promise, a chunk that would not load, a response that did
not match the contract the client compiled against.

The server records every request it answers in `request_log`. It is
structurally blind to all of the above — none of them reach it. This library
is how they do.

## The seam

`ClientTelemetry` names three things and no vendor: `reportError`,
`addBreadcrumb`, `flush`. Reporting returns `void` and never throws, because
every caller is already inside a failure and none of them can afford a second
one.

There is deliberately no `identify`. Who the user is comes from the session
the server already resolved, so the browser never asserts an identity and no
principal data has to live here.

## Drivers

| Driver  | Reports to                                        | For                                  |
| ------- | ------------------------------------------------- | ------------------------------------ |
| `none`  | nowhere                                           | the default; plant-local and offline |
| `local` | `/api/client-diagnostics`, same-origin, keepalive | the cloud web app and the kiosks     |

Adding a vendor adds a member to `ClientTelemetryDriver` and a branch in
`createClientTelemetry`. Nothing else moves — no call site, no capture
surface, no envelope.

## What gets reported

`shouldReportFailure` is the judgement, and it is a pure function with its own
tests because it is what keeps this from becoming noise. Faults are reported;
refusals are not. A 4xx is the API working, an expired session is already
handled, and intermittent connectivity is expected.

See ADR-0117 and observability.

The fault reporting contract lives in
[`@dads-framework/client-telemetry-core`](../telemetry-core/README.md). The
package re-exports it and runs shared conformance against the Sentry driver.
