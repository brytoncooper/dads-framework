# `@dads-framework/postgres-access`

Check permissions, list the resources a user can access, and commit relationship
changes alongside business data in the application's Postgres database. Works
directly with a plain `pg.Pool` (zero ORM required) or with Drizzle via
`@dads-framework/postgres-access/drizzle`.

## Trusted experimental

We recommend this adapter when your app keeps its records and permission
relationships in the same Postgres database and your policy fits the
[supported model](#what-it-refuses-to-do). For example, removing a workspace
member can delete their membership row and revoke their access in one
transaction. Both changes commit together or both roll back. A check using
a fresh snapshot on the primary sees the revocation as soon as it commits. That
removes the authorization outbox, its delivery worker, and the interval
during which a committed revoke would still be waiting for delivery.

Its access decisions and visible resource lists have been checked against
SpiceDB. The [live transaction tests](./src/protected-transaction.integration.test.ts)
and [plain pg transaction tests](./src/plain-pg-transaction.integration.test.ts)
cover revocation and rollback. The [graph tests](./src/recursive-subject-set.integration.test.ts)
also exercise nested memberships up to 10,000 links.

Start with one protected operation and test a grant, a denial, and a
revocation with your own policy. Measure checks and lists while permissions
are changing. Sustained production performance under that mix is still open.
See the [benchmark results](./BENCHMARK.md) for measured workloads.

## Protected writes

### Plain `pg.Pool` (Drizzle-free)

Use `withProtectedPgTransaction({ pool, authorization }, work)` when a decision
protects a write on a standard node-postgres pool. The helper checks out a
client, starts `BEGIN ISOLATION LEVEL SERIALIZABLE`, and passes
`{ client, authorization }` bound to that client. Check access again inside the
callback (for example via `authorization.can(user(id), document.permissions.edit, docId)` or `createAccessClient(authorization)`), run application
SQL on `client`, and await all work before returning. The authorization handle
expires as soon as the callback finishes or throws.

For paginated reads that combine `resolveFilter(...)` with a `SELECT`, use
`withReadSnapshot({ pool, authorization }, work)` to run inside
`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY` on one MVCC
snapshot without serializable write-conflict retry overhead.

### Drizzle (`@dads-framework/postgres-access/drizzle`)

If your app uses Drizzle, import `withProtectedDrizzleTransaction` (and
`transactionExecutor`) from `@dads-framework/postgres-access/drizzle`. Pass
`{ database, authorization }` to open a serializable Drizzle transaction, or
`{ transaction: tx, authorization }` to join an existing serializable
transaction. Core `withProtectedPostgresTransaction` and
`withProtectedPgTransaction` both target plain `pg.Pool` with zero Drizzle
dependency. When joining an outer transaction, the caller still owns commit and
rollback; propagate failures so the outer transaction rolls back (the helper
does not create a savepoint).

### Serialization conflicts and ordering

A PostgreSQL serialization failure (`40001`) surfaces as
`PostgresSerializationConflict` with code `POSTGRES_CONFLICT` and
`retryable: true`. A caller that owns an outer commit can use
`readPostgresSerializationConflict(error)` to classify a failure raised there.
Pass `retries` (and optional `retryBaseDelayMs`, default `15`) to
`withProtectedPgTransaction({ pool, authorization, retries: 3 }, work)` to
automatically retry idempotent callbacks with jittered exponential backoff on
`40001` conflicts. By default `retries` is `0`, invoking the callback at most
once per call.

Serializable isolation makes the commit consistent with a serial ordering of
transactions. A revoke committed before the permission check's transaction
snapshot is visible to that check. An overlapping revoke may serialize after
the protected write. If an operation requires revocation to take precedence
over an overlapping write, coordinate both operations through an application
lock or equivalent ordering mechanism. For reads and explicit tuple changes in
an existing transaction, use `inTransaction` or `inDrizzleTransaction`.

## Try it

In the generated starter, [`assembly/services.ts`](../../../apps/kit-workbench/assembly/services.ts) creates the Postgres
adapter and connects it to tenant services using the application database.
[`assembly/protected-write.ts`](../../../apps/kit-workbench/assembly/protected-write.ts) checks permission in the transaction
that commits the protected write.

Use Node.js 22 or later and an empty development Postgres database. Set
`DATABASE_URL` to a connection string for a role that can create tables and
indexes. The script installs the relationship schema and uses a fresh
namespace per run. In an application, apply the SQL through your migration
runner and use a stable namespace.

```sh
npm install @dads-framework/access @dads-framework/postgres-access pg
npm install -D tsx @types/pg
```

Save as `check-postgres-access.mts` and run `npx tsx check-postgres-access.mts`.

<!-- dads:check-example -->

```ts
import { randomUUID } from "node:crypto";
import { actor, compileAccess, resource } from "@dads-framework/access";
import { createAccessClient } from "@dads-framework/access/runtime";
import {
  PostgresAuthorization,
  relationshipSchemaMigration,
  withProtectedPgTransaction,
} from "@dads-framework/postgres-access";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set DATABASE_URL.");

const user = actor("user");
const organization = resource("organization", {
  roles: { admin: user, member: user },
  can: ({ admin, member }) => ({
    manage: admin,
    view: [admin, member],
  }),
  children: {
    task: {
      inherit: "all",
      roles: { assignee: user },
      can: ({ assignee }) => ({ edit: assignee }),
    },
  },
});
const model = compileAccess([organization]);

const pool = new Pool({ connectionString });
try {
  await pool.query(relationshipSchemaMigration.sql);
  const authorization = new PostgresAuthorization({
    model,
    namespace: randomUUID(),
    executor: pool,
  });
  const access = createAccessClient(authorization);

  console.log(await access.can(user("alice"), organization.task("task-1").view));
  await withProtectedPgTransaction({ pool, authorization }, async ({ authorization: scoped }) => {
    const txAccess = createAccessClient(scoped);
    await txAccess.add(user("alice"), organization("org-1").member);
    await txAccess.add(organization("org-1"), organization.task("task-1").organization);
  });
  console.log(await access.can(user("alice"), organization.task("task-1").view));
  await access.remove(user("alice"), organization("org-1").member);
  console.log(await access.can(user("alice"), organization.task("task-1").view));
} finally {
  await pool.end();
}
```

The script prints `false`, `true`, and `false` as organization membership is
granted and revoked while `task` inherits `view` from `organization`.

## Use it

Choose Postgres for an app that already uses Postgres and can keep relationship
facts beside its data. Install `relationshipSchemaMigration.sql` through the
app's migration runner. Configure a stable namespace for this model, and pass a
plain `pg.Pool` as `executor` when constructing `PostgresAuthorization`. Use
`createAccessClient(authorization)` from `@dads-framework/access/runtime` for
typed `add`, `remove`, `can`, `list`, `whoCan`, and `listDirect` calls.

When integrating with Dads outbox ports, bind `TransactionalAccessChanges` as
the enqueue port and `AlreadyAppliedAccessChanges` as the after-commit
dispatcher. Pass the active transaction to `enqueue(entries, tx)` so
relationship facts and business rows commit or roll back together.

In Postgres mode, start neither the access-change projector nor the SpiceDB
migration runner. Successful writes return an empty consistency token. Data
visibility follows the caller's Postgres transaction. The after-commit
dispatcher is a no-op because committed facts are already visible. Keep any
application locks that coordinate work beyond projecting authorization facts.

To evolve stored relationships between model revisions or migrate a live
SpiceDB deployment into PostgreSQL, use
[`@dads-framework/spicedb-access/migration`](../spicedb-access/README.md).
The [SpiceDB adapter](../spicedb-access/README.md) remains available when you
need a separate graph store with a Postgres outbox.

## What it refuses to do

Compilation rejects missing relation or permission targets, empty expressions,
local same-entity permission cycles, non-monotonic arrow cycles (cycles passing
through `excluding` / `.unless()` or `throughAll` / `every()`), non-linear
multi-branch cycles, and unproductive cycles with no base case. Arrows need at
least one direct target entity type that defines the requested permission;
target types on a polymorphic relation that do not define the permission are
skipped. Permission checks and resource lookups require a concrete subject;
`lookupSubjects` requires a concrete resource and a non-empty subject type;
relationship writes can contain wildcard and subject-set tuples.

The enqueue port rejects a database handle in place of an application
transaction. Its transaction-bound changes are exact tuple writes or deletes. A
broad revocation sweep needs its filters passed to a transaction-bound adapter
if it must commit with the business update.

## Contract

`PostgresAuthorization` implements the authorization port's checks, ordered bulk
checks, resource discovery (`lookupResources`), transitive subject discovery
(`lookupSubjects`), relationship writes and filtered deletes, direct-subject
listing, and relationship existence reads. Unknown permission names give denied
checks, empty resource lookups, and `{ subjects: [], hasWildcard: false }` for
`lookupSubjects`. Invalid tuple writes and failed storage operations reject.

- **Compiled SQL list filters (`compileFilter` / `resolveFilter`)**: `authorization.compileFilter({ subject, permission, idColumn, scopeColumns?, paramOffset? })` and `authorization.resolveFilter(...)` accept either a typed `PermissionToken` (`document.permissions.view`, inferring `resourceType` automatically) or explicit `{ permission, resourceType }` wire strings, and return `{ sql, values }` so paginated, sorted `SELECT ... WHERE ... LIMIT N` queries filter authorized rows in one database round trip without loading ID lists into Node. Pass `scopeColumns: "auto"` to derive parent foreign-key mappings automatically from `columnRelations`. Validates `idColumn` strictly and fails closed to `FALSE` on unknown permissions.
- **Column-backed relations (`columnRelations`)**: Bind single-target FK relations directly to columns on application tables (parent FKs such as `documents.org_id`, recursive self-FKs such as `folders.parent_id`, or direct actor FKs such as `documents.owner_id`) so authorization reads them directly with zero dual-writes and zero duplicate tuple storage. `NULL` values mean no relationship. `writeRelationships` and `deleteRelationships` refuse manual mutations on column-backed relations to preserve a single source of truth. Run `await authorization.verifyColumnRelations()` at startup to verify live columns and check reverse-lookup indexes, and generate recommended index DDL with `columnRelationIndexSql(bindings)`. Cannot be combined with `reuseLookupResultsOn`.
- **Expiring relationships (`expiresAt`)**: `relationshipSchemaMigration` creates `expires_at timestamptz NULL` with a partial index (`dad_authorization_relationship_expires_at`). Existing v1 installations can apply the additive `relationshipExpirationMigration` (version 2). `writeRelationships` persists `expiresAt ?? null` with `ON CONFLICT (...) DO UPDATE SET expires_at = EXCLUDED.expires_at` so re-writing a tuple updates or clears its expiration. Every read (`check`, `checkMany`, `lookupResources`, `lookupSubjects`, `compileFilter`, `listDirectSubjects`, and `relationshipExists`) filters `(expires_at IS NULL OR expires_at > now())` using transaction-scoped Postgres `now()`.
- **Polymorphic arrows**: Relations with multiple direct entity types (such as `parents: [organization, folder]`) lower parent arrows and `every()` across every target entity type that defines the target permission, matching `subject_kind` per branch across checks, resource lookups, filters, shared point checks, and subject lookups.
- **Recursive arrows**: Monotonic self-referential and mutually recursive arrow cycles (such as nested folders with `recursive: true`) compile to `WITH RECURSIVE` CTEs with `UNION` deduplication so cyclic tuple data terminates safely across `check`, `checkMany`, `lookupResources`, `compileFilter`, and `lookupSubjects`.
- **Intersection arrows (`every()`)**: Compiles to SpiceDB's `.all()` semantics (`EXISTS` at least one non-expired parent tuple `AND NOT EXISTS` a non-expired parent tuple failing the target permission) across `check`, `checkMany`, `lookupResources`, `compileFilter`, and `lookupSubjects`.
- **Transitive `lookupSubjects`**: Evaluates a single parameterized SQL query returning sorted unique concrete `subjects` and `hasWildcard` across direct roles, recursive usersets, wildcards, `allOf`, `.unless()`, polymorphic arrows, recursive arrows, `every()`, and `expires_at`. Available on root, `inTransaction`, `inDrizzleTransaction`, and protected transaction scopes.

For operations on a root adapter, `queryTimeoutMs` defaults to 5,000 ms. It
is a client deadline for executors that honor node-postgres query options.
Configure a server-side `statement_timeout` in the application as needed.
Drizzle transaction operations use the application's database settings.
Connection management and schema migration remain application-owned.

With Docker available, run the integration suite from a built checkout:

```sh
CONTAINER_PER_FILE=1 npm run test:integration -w @dads-framework/postgres-access
```

The [benchmark notes](./BENCHMARK.md) explain which read paths were measured.

### Testing (`@dads-framework/postgres-access/testing`)

Use `provePostgresFilterParity({ db, authorization, table, idColumn, permission, scopeColumns?, subjects })`
on a plain `pg.Pool` or client (no Drizzle required) to prove that
`compileFilter`, `compileFilter({ scopeColumns })`, and `resolveFilter` return
the exact same row IDs as `lookupResources` for every subject. Combine with
`proveAccess` or `proveWorld` from `@dads-framework/access/testing` to run
multi-step Postgres scenarios under a single `await`.

### Optimize point checks

For a direct node-postgres pool, opt in by passing
`executor: preparePostgresChecks(pool)`. Share the wrapper across authorization
namespaces. The wrapper can admit up to 64 distinct SQL shapes of at most 4 KiB
each and 32 KiB total per pool lifetime. Other shapes execute unnamed, as do
bulk checks, lookups, and writes. PostgreSQL decides when each connection can
reuse a generic plan. New connections and the first checks on each connection
still pay planning costs.

Checks always read the facts visible to the executing transaction. The wrapper
stores statement names and SQL shapes, and PostgreSQL stores plans per
connection. Use the ordinary executor for connections through poolers that do
not support protocol-level named statements. Drizzle-bound transactions
continue using their own execution path.

Prepared single checks can fuse a chain of four to 32 arrows ending in one
relation into an indexed recursive query. The query preserves wildcard grants
and recursive subject sets. If the bounded traversal completes without a
match, it denies. If the traversal reaches its bound without deciding, the
adapter runs the full check unnamed with the remaining query deadline.
Small ordinary point checks may also use named statements when their policy
has at most two arrows and four total relation or arrow references.
Larger point checks, bulk checks, and Drizzle transactions run unnamed.
A bulk branch with four to 32 linear arrows evaluates the complete
permission once per distinct subject and joins the results to the original
request ordinals. Mixed permissions, denials, and duplicate request rows
keep their order in the same SQL statement.
If a point policy expands beyond 64 KiB of forward SQL, the adapter compiles
a single Boolean query that shares repeated permission expressions and matches
the requested resource in PostgreSQL. It reads current relationship facts
under the configured query deadline.

### Reuse large lookup results

By default, `lookupResources` evaluates the current relationship graph on
every call. For repeated lookups in a read-mostly service, an application can
opt in to reusing immutable ID lists. A reused list still makes a fresh
database round trip for every call. Transaction-bound adapters always
evaluate within their transaction.

Install `lookupRevisionSchemaMigration` after `relationshipSchemaMigration`
in the application's normal migration runner. Apply the optional migration
in one transaction as the migration owner. Existing v1 installations can
continue without it. This mode requires the durable, unpartitioned
`public.dad_authorization_relationship` table without row-level security.

Use a direct node-postgres 8.21+ pool connected to one primary. Configure its
role and search path once and keep the pool out of session-routing middleware.
The runtime role may use the tuple table and read revision metadata. Do not
grant runtime roles owner membership, schema DDL, revision writes, sequence
usage, or trigger privileges. For example, grant an existing runtime role:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.dad_authorization_relationship TO app_runtime;
GRANT USAGE ON SCHEMA dad_lookup_revision TO app_runtime;
GRANT SELECT ON dad_lookup_revision.epoch, dad_lookup_revision.namespace
  TO app_runtime;
```

```ts
const authorization = new PostgresAuthorization({
  model,
  namespace: "workspace",
  executor: pool,
  reuseLookupResultsOn: pool,
});
```

You can pass `preparePostgresChecks(pool)` as the executor with the same pool.
Write and read-only transaction clients do not qualify. Remove the option
before rolling the optional migration back. Failed validation rejects the
operation and clears retained answers. Table-wide tuple `SELECT` is checked for
every reuse, so revoking it prevents reuse even if revision metadata is still
readable.

The migration marks each touched namespace in the same transaction as
INSERT, DELETE, or UPDATE. Moving a tuple marks both namespaces, and
TRUNCATE changes a shared epoch. A miss reads the ID list and its revision in
one statement. Each reuse, including coalesced empty lists, validates its
revision against the primary after the call begins. Calls that overlap a
commit may observe the snapshot before or after it.

The application still owns database administration. Keep the triggers
installed for all writers, including direct SQL. Stop reuse while privileged
maintenance could bypass them. Reapply the migration to rotate the
installation revision before resuming. Recreate the authorization instances
if their pool changes authority or is restored. The cache retains a bounded
number of lists and IDs. Same-namespace writers share a revision row, so
concurrent writes may slow down. See the [benchmark](./BENCHMARK.md).
