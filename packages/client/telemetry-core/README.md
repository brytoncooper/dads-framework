# @dads-framework/client-telemetry-core

Accept `ClientTelemetry` to report client errors and breadcrumbs. Use
`NoneClientTelemetry` when the application has no recorder. Choose an HTTP or
vendor implementation with
[`@dads-framework/client-telemetry`](../telemetry/README.md).

## Provider contract

Reporting is synchronous and cannot throw. Flush resolves a delivery status.
The testing export includes an in-memory recorder and shared provider laws.
