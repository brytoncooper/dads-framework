# `@dads-framework/postgres-access`

Check permissions, list the resources a user can access, and commit relationship
changes alongside business data in the application's Postgres database.

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
cover revocation and rollback. The [graph tests](./src/recursive-subject-set.integration.test.ts)
also exercise nested memberships up to 10,000 links.

Start with one protected operation and test a grant, a denial and a
revocation with your own policy. Measure checks and lists while permissions
are changing. Sustained production performance under that mix is still open.
See the [benchmark results](./BENCHMARK.md) for measured workloads.

## Protected writes

Use `withProtectedPostgresTransaction({ database, authorization }, work)`
when a decision protects a write. The helper opens a serializable Drizzle
transaction and passes `{ tx, authorization }` to the callback. Check access
again inside the callback, even if the route already authorized the request.
Use these same handles for the application writes and relationship changes. Await all work before leaving the callback.
The authorization handle expires on return or error.

To join an existing transaction, pass `{ transaction: tx, authorization }`.
The helper verifies that it is already serializable and uses the same
transaction. The caller still owns commit and rollback. Propagate failures so
the outer transaction can roll back. The helper does not create a savepoint.

A PostgreSQL serialization failure surfaces as `PostgresSerializationConflict`
with code `POSTGRES_CONFLICT` and `retryable: true`. A caller that owns the
outer commit can use `readPostgresSerializationConflict(error)` to classify
a failure raised there. Retry the entire application transaction if retrying
is appropriate. The helper invokes the callback at most once per call.

Serializable isolation makes the commit consistent with a serial ordering of
transactions. A revoke committed before the permission check's transaction
snapshot is visible to that check. An overlapping revoke may serialize after
the protected write. If an operation requires revocation to take precedence
over an overlapping write, coordinate both operations through an application
lock or equivalent ordering mechanism. For reads and explicit tuple changes
in an existing transaction, use `inTransaction` or `inDrizzleTransaction`.

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
npm install @dads-framework/access @dads-framework/postgres @dads-framework/postgres-access zod
npm install -D tsx
```

Save as `check-postgres-access.mts` and run `npx tsx check-postgres-access.mts`.

<!-- dads:check-example -->

```ts
import { randomUUID } from "node:crypto";
import { access, accessModel, entityHandle } from "@dads-framework/access";
import { relationshipWrite } from "@dads-framework/access/runtime";
import { createPostgresConnection } from "@dads-framework/postgres";
import {
  PostgresAuthorization,
  relationshipSchemaMigration,
} from "@dads-framework/postgres-access";
import { z } from "zod";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set DATABASE_URL.");

const user = entityHandle({ wireName: "user", idSchema: z.string() });
const team = entityHandle({
  wireName: "team",
  idSchema: z.string(),
  kind: "scope",
});
const teamAccess = access(team, {
  roles: { member: user },
  permissions: (roles) => ({ view: [roles.member] }),
});
const model = accessModel([
  access(user, { roles: {}, permissions: () => ({}) }),
  teamAccess,
]);

const connection = createPostgresConnection(
  { connectionString, schema: {} },
  console,
);
try {
  await connection.pool.query(relationshipSchemaMigration.sql);
  const authorization = new PostgresAuthorization({
    model,
    namespace: randomUUID(),
    executor: connection.pool,
  });
  const resource = { type: team.wireName, id: "team-1" };
  const subject = { type: user.wireName, id: "alice" };
  const relation = teamAccess.roles.member.roleName;
  const query = {
    resource,
    subject,
    permission: teamAccess.permissions.view.permissionName,
  };

  console.log(await authorization.check(query));
  await authorization.writeRelationships([
    relationshipWrite(resource, relation, subject),
  ]);
  console.log(await authorization.check(query));
  await authorization.deleteRelationships({
    resourceType: resource.type,
    resourceId: resource.id,
    relation,
    subject,
  });
  console.log(await authorization.check(query));
} finally {
  await connection.close();
}
```

The script prints `false`, `true`, and `false` as the membership is granted
and revoked.

## Use it

Choose Postgres for an app that already uses Postgres and can keep relationship facts beside its data. Install the relationship schema through the app's migration runner. Configure a stable namespace for this model, and select the backend at application composition. Use the same model for Postgres policy compilation and HTTP scope planning.

Bind `TransactionalAccessChanges` as the enqueue port and
`AlreadyAppliedAccessChanges` as the after-commit dispatcher. The
application passes its active transaction to `enqueue(entries, tx)`.
Relationship facts and the business row then commit or roll back together.

In Postgres mode, start neither the access-change projector nor the SpiceDB migration runner. Successful writes return an empty consistency token. Data visibility follows the caller's Postgres transaction. The after-commit dispatcher is a no-op because committed facts are already visible. Keep any application locks that coordinate work beyond projecting authorization facts.

Choose the backend based on the model features the application needs, its
transaction requirements, and measurements with its own data and traffic.
The [SpiceDB adapter](../authorization/README.md) provides a separate graph
store, with a Postgres outbox for writes.

## What it refuses to do

Compilation rejects missing relation or permission targets, empty expressions, and local permission cycles. Cross-entity permission cycles are unsupported by the SQL engine. Each arrow needs one direct target entity type. Permission checks require a concrete subject; relationship writes can contain wildcard and subject-set tuples.

The enqueue port rejects a database handle in place of an application transaction. Its transaction-bound changes are exact tuple writes or deletes. A broad revocation sweep needs its filters passed to a transaction-bound adapter if it must commit with the business update.

## Contract

`PostgresAuthorization` implements the authorization port's checks, ordered bulk checks, discovery, relationship writes and filtered deletes, direct-subject listing, and relationship existence reads. Unknown permission names give denied checks and empty lookup results. Invalid tuple writes and failed storage operations reject.

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

### Optimize point checks

For a direct node-postgres pool, opt in by passing
`executor: preparePostgresChecks(connection.pool)`. Share the wrapper across
authorization namespaces. The wrapper can admit up to 64 distinct SQL shapes
of at most 4 KiB each and 32 KiB total per pool lifetime. Other shapes execute
unnamed, as do bulk checks, lookups, and writes. PostgreSQL decides when each
connection can reuse a generic plan. New connections and the first checks on
each connection still pay planning costs.

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
  executor: connection.pool,
  reuseLookupResultsOn: connection.pool,
});
```

You can pass `preparePostgresChecks(connection.pool)` as the executor with the
same pool. Write and read-only transaction clients do not qualify. Remove the
option before rolling the optional migration back. Failed validation rejects
the operation and clears retained answers. Table-wide tuple `SELECT` is checked
for every reuse, so revoking it prevents reuse even if revision metadata is
still readable.

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
