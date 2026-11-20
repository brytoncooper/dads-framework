# Feature flags

Define the flag in code and choose which audience can see it. Evaluate flags
using the tenant context on the server for requests that need it. Treat a flag
as rollout state; a permission still decides whether the caller can reach
a protected operation.

Use the [feature flag kit](../../../packages/server/feature-flags/README.md)
for definitions and revision-checked changes. Choose
[Postgres storage](../../../packages/server/feature-flags-postgres/README.md)
and an [HTTP binding](../../../packages/server/feature-flags-http/README.md)
at the application boundary. The
[composition test](../../../packages/server/feature-flags/src/lib/compose-feature-flags.test.ts)
shows the configuration with an in-memory store.
