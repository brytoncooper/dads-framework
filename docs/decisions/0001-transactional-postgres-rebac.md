# ADR-0001: Compile ReBAC into PostgreSQL Transactions Behind the Shared Access Runtime Port

## Status

Accepted

## Date

2026-11-20

## Context

Dads applications store business records such as tenants, memberships, and notes in PostgreSQL. When permission relationships live in a separate authorization datastore, removing a workspace member updates PostgreSQL first and delivers the tuple deletion later through an authorization outbox. Until the delivery worker commits that update, the external permissions service can keep authorizing the removed member (illustrated in [Who let Gary back in?](../go-ask-your-other-database.md)).

Operating a second datastore, an outbox table, and a background projector also adds deployment and failure-mode overhead for teams whose records and relationships fit inside PostgreSQL. At the same time, larger deployments or complex graph topologies can outgrow single-database SQL evaluation and require a dedicated graph engine such as SpiceDB.

## Decision

Compile the TypeScript relationship model declared with `@dads-framework/access` into SQL queries in `@dads-framework/postgres-access` (`PostgresAuthorization`) over the `public.dad_authorization_relationship` table, while keeping SpiceDB (`@dads-framework/authorization`, `SpiceDbAuthorization`) behind the same `@dads-framework/access/runtime` port.

1. **Shared runtime port:** Domain routes, HTTP enforcement (`@dads-framework/http`), and list scoping target `@dads-framework/access/runtime` (`Authorization`, `AccessChanges`, `evaluateRouteAccess`) and test against `FakeAuthorization` in `@dads-framework/access/testing`. The composition root selects either `PostgresAuthorization` or `SpiceDbAuthorization` (`apps/kit-workbench/assembly/services.ts`) without changing domain code.
2. **Single-transaction writes and revocations:** In PostgreSQL mode, applications bind `TransactionalAccessChanges` as the enqueue port and `AlreadyAppliedAccessChanges` as the after-commit no-op dispatcher. Membership writes, SCIM user deactivations, and tuple deletes commit or roll back inside one PostgreSQL transaction.
3. **Serializable protected writes:** Mutations guarded by a permission check run inside `withProtectedPostgresTransaction({ database, authorization }, work)`, which opens a serializable Drizzle transaction, rechecks permission on the transaction-bound authorization handle, and surfaces PostgreSQL serialization failures as retryable `PostgresSerializationConflict` (`POSTGRES_CONFLICT`).
4. **Opt-in read tuning:** Callers can opt in to named prepared point checks (`preparePostgresChecks(connection.pool)`) and revision-validated `lookupResources` caching (`lookupRevisionSchemaMigration` plus `reuseLookupResultsOn`).
5. **Explicit maturity boundary:** `@dads-framework/postgres-access` carries Trusted experimental status until teams benchmark sustained concurrent read/write traffic against their own schemas.

## Alternatives considered

### Require SpiceDB with a PostgreSQL outbox for all applications

- **Pros:** Supports arbitrary graph topologies, isolates authorization read load from the primary OLTP database, and supports SpiceDB-native operational features. Dads keeps this path available in `@dads-framework/authorization`.
- **Cons:** Forces every starter and single-database app to operate a second datastore, a migration runner for Zed schemas, an outbox table, and a projector worker, while introducing a delivery window after revocations.
- **Rejected as the sole backend:** Single-database applications need transactional revocation without running a second distributed store.

### Check `tenant_id` columns and role flags inside route handlers

- **Pros:** Needs no tuple table or SQL compiler.
- **Cons:** Scatters authorization predicates across controllers and queries, breeds `if`-ladders (`role-if-ladders` and `tenant-column-authorization` signals in `dad doctor`), and cannot express inherited or multi-hop relationships across routes and lists.
- **Rejected:** Ad-hoc role checks drift between endpoints and cannot share one verifiable permission model.

### Enforce authorization through PostgreSQL Row-Level Security (RLS) alone

- **Pros:** Enforces row filtering inside PostgreSQL for every SQL query on a protected table.
- **Cons:** Ties access rules to SQL DDL and session variables rather than the typed TypeScript `accessModel` that also powers HTTP edge checks, scoped list planning, in-memory unit tests, and SpiceDB schema emission (`emitZed`).
- **Rejected:** RLS cannot serve as the portable model shared by HTTP enforcement, tests, and optional SpiceDB deployments.

## Consequences

- Removing a tenant member or deactivating a linked SCIM user deletes the membership row and revokes authorization tuples in one atomic commit. Fresh checks on the primary observe the revocation on the next query with zero outbox lag.
- Starters run with one database and omit the SpiceDB migration runner and outbox projector.
- Matched local VM benchmarks ([benchmark notes](../../packages/server/postgres-access/BENCHMARK.md)) measure warm prepared point checks on a 5,000-leaf fixture at 0.184 to 0.440 ms p50 across 2, 8, and 16 arrows on PostgreSQL 16.16.
- The SQL compiler rejects cross-entity permission cycles, empty expressions, and multi-target arrows, and `@dads-framework/access` omits SpiceDB caveats.
- Serializable protected writes can raise `PostgresSerializationConflict`, so callers must retry whole transactions (the starter maps this to HTTP `409` in [`assembly/protected-write.ts`](../../apps/kit-workbench/assembly/protected-write.ts)).
- Enabling optional `lookupRevisionSchemaMigration` caching shares one revision row per namespace, which can slow concurrent writes within the same namespace.
- Teams that outgrow PostgreSQL evaluation can switch to `@dads-framework/authorization` at composition time without rewriting routes or domain handlers.

## References

- [Who let Gary back in?](../go-ask-your-other-database.md)
- [`@dads-framework/postgres-access` README](../../packages/server/postgres-access/README.md)
- [`@dads-framework/postgres-access` benchmark notes](../../packages/server/postgres-access/BENCHMARK.md)
- [`@dads-framework/authorization` README](../../packages/server/authorization/README.md)
- [`@dads-framework/access` README](../../packages/access/README.md)
- [Starter service wiring](../../apps/kit-workbench/assembly/services.ts)
- [Starter protected write helper](../../apps/kit-workbench/assembly/protected-write.ts)
