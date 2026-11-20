# `@dads-framework/telemetry-core`

Correlate server spans with request records using a bounded request ID and the
audit actor's kind. Use this package at the host boundary when building a
reporter or adapter. To export Node HTTP and Postgres spans to a collector,
use [the telemetry package](../telemetry/README.md).

## Contract

`requestTraceAttributes` accepts the two facts a server has resolved for its
request. It emits the actor kind and includes the request ID when it matches
the correlation-token format. A request ID that contains whitespace or exceeds
128 characters is omitted.

The `testing` entry point supplies an in-memory recorder and the same
attribution cases used to verify the OTLP adapter.
