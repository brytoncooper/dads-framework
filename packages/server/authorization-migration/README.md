# `@dads-framework/authorization-migration`

Scaffold and apply ordered SpiceDB schema snapshots and relationship migration steps.

## Try it

The generated starter uses Postgres for authorization in
[`assembly/services.ts`](../../../apps/kit-workbench/assembly/services.ts). For the SpiceDB schema journal, see the repository's
[journal runner tests](./src/lib/run-authorization-migrations.test.ts), which
show ordered application and a rerun that skips applied entries.

Use Node.js 22 or later. The script creates a temporary journal, previews the
first migration ID, then checks that scaffolding the same schema again is a
no-op. No SpiceDB instance is needed to scaffold.

```sh
npm install @dads-framework/authorization-migration
npm install -D tsx
```

Save as `scaffold-journal.mts` and run `npx tsx scaffold-journal.mts`.

<!-- dads:check-example -->

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listShippedAuthorizationMigrationIds,
  scaffoldMigration,
} from "@dads-framework/authorization-migration";

const journalFolder = await mkdtemp(join(tmpdir(), "dads-journal-"));
try {
  const input = {
    journalFolder,
    mode: "new",
    slug: "baseline",
    composedSchema: `
definition authz/migration_version {}
definition authz/migration_journal {
  relation applied: authz/migration_version
}
definition user {}
`,
  } satisfies Parameters<typeof scaffoldMigration>[0];

  console.log((await scaffoldMigration(input)).action);
  console.log(
    (await listShippedAuthorizationMigrationIds(journalFolder)).join(),
  );
  console.log((await scaffoldMigration(input)).action);
} finally {
  await rm(journalFolder, { recursive: true, force: true });
}
```

The script prints `created`, `0001_baseline`, and `up-to-date`. To retain
the generated `index.ts`, `schema.zed`, and `migration.ts` in your app, use
an existing journal directory and omit the temporary directory cleanup.

## Use it

Pass the generated index's `journal`, the absolute path of its directory, an
`AuthorizationMigrationStore`, and a logger with an `info` method to
`runAuthorizationMigrations`. For a development run against SpiceDB, start
with a dedicated datastore and construct `SpiceDbAuthorization` from
`@dads-framework/authorization` with its endpoint and credentials. Pass the
adapter as `store`. A successful run logs the applied ID. Rerunning the
same journal reports zero newly applied entries.

For independently authored patches, use `scaffoldAuthorizationChange` and
pass their directory as `changesFolder` on the same runner. Each patch
records the definitions it changes and the changes it depends on.
`renumberMigration` moves a snapshot entry that collided with another branch.

For connected `(from, to)` access model migrations across Postgres, SQLite,
and SpiceDB, classify changes with `diffAccessModels` or `diffAccessIr`,
declare portable steps with `defineAccessMigration` (`copyRole`, `dropRole`,
`copyParent`, `dropParent`), apply them with `runPostgresAccessMigrations`,
`runSqliteAccessMigrations`, or `runSpiceDbAccessMigrations`, and gate startup
with `assertAccessMigrationsUpToDate`.

To migrate a live SpiceDB datastore into Postgres, call
`migrateSpiceDbToPostgres` with a `@authzed/authzed-node` v1 client (or
`createAuthzedMigrationSource`) and a Postgres executor, then verify decision
equivalence with `verifySpiceDbPostgresParity`.

To migrate in the reverse direction — from Postgres (including any
`columnRelations` foreign keys on application tables) out to SpiceDB — call
`migratePostgresToSpiceDb({ model, postgres, spiceDb, namespace, columnRelations })`.
It emits and writes the `.zed` schema, streams active tuples from
`dad_authorization_relationship`, materializes every non-`NULL` `columnRelations`
row via keyset pagination into idempotent SpiceDB `TOUCH` writes, and returns
ready-to-apply `outboxTriggers` DDL (`columnRelationOutboxTriggerSql`) so future
`INSERT`/`UPDATE`/`DELETE` statements on column-backed tables feed
`authorization_outbox` automatically with zero app-code rewrites. Verify parity
before cutover with `verifySpiceDbPostgresParity`.

You can also run the same workflow from the command line with
`npx dads-import-spicedb`:

```sh
npx dads-import-spicedb \
  --endpoint localhost:50051 \
  --token "$SPICEDB_TOKEN" \
  --database-url "$DATABASE_URL" \
  --namespace acme \
  --out ./src/access-model.ts \
  --verify
```

`--token` falls back to `SPICEDB_TOKEN` and `--database-url` falls back to
`DATABASE_URL`. Pass `--insecure` for local plaintext SpiceDB instances,
`--dry-run` to preview the generated TypeScript without touching Postgres or
disk, `--batch-size <n>` to control upsert batching, and `--json` for
machine-readable output. The CLI loads `@authzed/authzed-node`, `pg`, and (for
`--verify`) `@dads-framework/postgres-access` dynamically at runtime.

## What it refuses to do

The runner rejects gaps, duplicate entries, unregistered folders, and snapshots
that drop the journal definition. A destructive entry after the baseline
requires the relationship steps that make its schema write legal.
`migrateSpiceDbToPostgres` fails fast with line-numbered errors on unsupported
`caveat` declarations or caveated relationships before writing to Postgres.
`assertAccessMigrationsUpToDate` throws listing every missing migration ID
when a database is behind.

## Contract

Each `NNNN_slug` holds a full schema snapshot. The runner calls
`beforeSchemaWrite`, writes the snapshot, and then calls `afterSchemaWrite`
when those steps are present. It records success as an
`authz/migration_version` relationship. A failure leaves the marker
unwritten. Make relationship steps safe to repeat when retrying an entry.
