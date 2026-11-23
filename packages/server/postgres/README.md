# @dads-framework/postgres — the Postgres pool and Drizzle handle

Open and close Postgres connections in application wiring so database adapters
can share one pool. This package owns the pool and the Drizzle instance (`createPostgresConnection`),
plus pool lifecycle/teardown, and the adapter helpers `isUniqueViolation` and
`loadPageAndTotal`/`sqlOffsetForPage`. Domain code never imports `drizzle-orm`
directly — it talks to the per-domain `<entity>-reader`/`<entity>-writer`
contracts whose `drizzle-` implementations live in each domain's `database/`
folder (docs/architecture/api-domains.md; exact surface in
docs/reference/database.md). `./testing` has Testcontainers helpers.

`connectPostgresClient(connectionString)` opens a dedicated client for operations
that hold session state, such as the migration runner's advisory lock. The
caller ends the client. `RehearsalPostgres.start()` from `./testing` starts an
isolated cluster for migration rehearsals that create databases and compare
cluster-wide state. Call the returned `stop()` when the rehearsal ends.

Each test file gets its own database on the shared test container. Stopping it
closes its pool, disables connections, and waits for its remaining backends to
terminate. The inaccessible database stays on disk until the shared-container
owner stops the container, bounding retention to that owner's lifetime and
avoiding the server-wide checkpoint required by `DROP DATABASE`. A file that
owns its own container closes its pool and stops that container.

For several isolated databases on one fixture server, call
`createPrivateDatabase(server.connectionString, {})` from `./testing` for each
database. Stop each database when its case ends and stop the fixture server
after the suite.

## Versioned updates

Call `updateAtRowVersion(tx, table, input)` in the transaction that owns a save. The caller scopes `input.where` to one row. The helper advances the integer revision and returns an empty result when the predicate or expected revision did not match. See the [versioned update guide](../../../docs/architecture/stale-save.md).

## Schema-keyed integration tests

Nx integration suites using the shared database can opt in to table-granular
hashing with the `databaseSharedState` named input. Include each generated table
folder the suite can reach in its inputs, including tables owned by framework
packages. A suite that runs migrations itself or reads the migration journal
needs the `databaseMigrations` named input instead.

## Try it

In a Node.js 22+ project, install the package.

```sh
npm install @dads-framework/postgres
```

Set `DATABASE_URL` to the connection string for a running PostgreSQL database.

Save this as `example.mts` and run `node --experimental-strip-types example.mts`.

<!-- dads:check-example -->

```ts
import { connectPostgresClient } from "@dads-framework/postgres";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) throw new Error("Set DATABASE_URL");

const client = await connectPostgresClient(databaseUrl);
try {
  const result = await client.query<{ answer: number }>("SELECT 1 AS answer");
  console.log(result.rows[0]?.answer);
} finally {
  await client.end();
}
```

The script prints `1` and closes the connection.

In the generated app, `assembly/services.ts` opens the shared application
connection and closes it when the provider stops. [Starter service wiring](../../../apps/kit-workbench/assembly/services.ts)

## What it refuses to do

This package manages database connections. Applications provide connection configuration and own schema migrations.

## Drizzle integration

Use `@dads-framework/postgres/drizzle` for the native database handle and its
schema-generic query type. The query type follows the native factory result
and preserves the original default schema. The root still exports
`DrizzleHandle` for compatibility.

## Plugin service tokens

Import `databaseService` (`DrizzleHandle`) or `postgresPoolService` (`PgPool`)
in plugins that require PostgreSQL without binding to host startup code.
`providePostgresDatabase(options)` opens a managed connection with
`createPostgresConnection`, provides `databaseService`, and registers
`connection.close` on the plugin scope so the pool ends on shutdown.

## Connection contract

Plain and attributed pools provide the same checkout, release, and teardown
behavior. The Drizzle handle uses the same pool, and each transaction keeps
its writes isolated until commit. Both modes run the connection conformance
suite against live PostgreSQL.

The adapter's `dadsConformance` declaration points to one suite and the two
provider registrations that run it. Both use the same PostgreSQL server. The
native pool implements checkout directly and the attributed pool adds a
checkout stamp while preserving native behavior. This tests pool semantics
and does not imply portability to another database protocol.
