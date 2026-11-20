# @dads-framework/audit

Find who changed an audited row, what changed, and which request caused it.
The kit also records requests and client diagnostics. `composeAudit` wires
their retention jobs and diagnostic route to the application's services.

## Try it

Use Node.js 22 or later and a disposable Postgres database. Set
`DATABASE_URL` to the migrated database. Apply the audit schema through
`installAuditSchemaV1(pgm)` in your migration runner, create the example
table, and attach the trigger as shown under [Use it](#use-it). The
application must authorize access before invoking the audit reader.

```sh
npm install @dads-framework/audit @dads-framework/audit-actor @dads-framework/postgres
npm install -D tsx
```

Save as `record-audit.mts` and run `npx tsx record-audit.mts`.

<!-- dads:check-example -->

```ts
import { randomUUID } from "node:crypto";
import { DrizzleAuditLogReader } from "@dads-framework/audit";
import {
  currentAuditActor,
  withSystemActor,
} from "@dads-framework/audit-actor";
import { createPostgresConnection } from "@dads-framework/postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set DATABASE_URL.");

const connection = createPostgresConnection(
  {
    connectionString,
    schema: {},
    auditActorSource: currentAuditActor,
  },
  console,
);
try {
  const id = randomUUID();
  const workspace = "audit-example";
  await withSystemActor("example-import", () =>
    connection.pool.query(
      "INSERT INTO documents (id, workspace_key, project_key) VALUES ($1, $2, $3)",
      [id, workspace, "example-project"],
    ),
  );

  const reader = new DrizzleAuditLogReader(connection.drizzle);
  const filter = { record: { tableName: "documents", rowKey: { id } } };
  const rows = await reader.listRows(
    { kind: "application", values: { workspace } },
    filter,
    null,
    10,
  );
  console.log(rows.map(({ operation, actorId }) => [operation, actorId]));
  const outside = await reader.listRows(
    { kind: "application", values: { workspace: "unrelated" } },
    filter,
    null,
    10,
  );
  console.log(outside.length);
} finally {
  await connection.close();
}
```

The result is one row with operation `insert` and actor ID `example-import`,
then `0` for the unrelated workspace.

## Use it

Register a migration after the audit schema migration. For the example, add
the table before attaching the trigger.

```ts
import { configureAuditTriggers } from "@dads-framework/audit/schema";
import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder) {
  pgm.sql(`
    CREATE TABLE public.documents (
      id uuid PRIMARY KEY,
      workspace_key text NOT NULL,
      project_key text NOT NULL
    )
  `);
  configureAuditTriggers(pgm, {
    tables: {
      documents: {
        keyColumns: ["id"],
        scopeColumns: { workspace: "workspace_key", project: "project_key" },
      },
    },
  });
}
```

In an application migration, declare each audited table's identity columns and
map any scope dimensions. Use `excludeTables` to explicitly remove triggers
from existing tables such as temporary credential storage.

The migration reconciles each named table's trigger in the public schema.
Name new tables in their own application migration. Audit-owned tables are
always excluded from this configuration. Configuration changes affect future
writes. The kit keeps previously recorded audit entries intact.

### Read the audit trail

Capture dimensions from the affected row at write time. Read them with
`{ kind: "application", values: { workspace: "example" } }`. All supplied
dimensions must match, and an empty scope matches nothing. An update that
changes a dimension is excluded from reads constrained by that dimension, so
a scope never exposes the other scope's row image. A platform read includes those updates.

Wrap writes in an audit actor context or use the attributed Postgres pool
from an application request or job. Applications can supply their own actor
kinds and request attribution. An audited write without an actor stamp
fails before it commits.

## Export audit metadata for a tenant

Build the exporter with the audit reader, the tenant dimension configured on
your audited tables, and an application permission check. This handler fragment
assumes `auditReader` is your `AuditLogReader` and `canExportAuditLog` checks
the authenticated caller's export permission for the supplied tenant.

```ts
import { createAuditLogExporter } from "@dads-framework/audit";

const exportPage = createAuditLogExporter({
  reader: auditReader,
  tenantDimension: "workspace",
  authorize: (tenantId) => canExportAuditLog(caller, tenantId),
});

const first = await exportPage({ tenantId: "example", pageSize: 100 });
if (first.kind === "page") {
  // Write first.body as first.contentType and return first.nextCursor.
}
```

The exporter checks the permission on every page before reading the audit log.
A denied request returns `{ kind: "denied" }`. Malformed input throws a Zod
validation error. The permission check must cover all audit metadata in the
requested tenant. Serve the page through an authenticated handler and prevent
shared caching of its contents.

Each successful page contains zero or more newline-terminated JSON objects as
`application/x-ndjson`. Each object includes the position, exact UTC timestamp,
actor kind and ID, user ID, request ID, table, operation, and changed column
names. Row keys, row images, actor reasons, and client fields stay in storage.

`pageSize` defaults to 100 and accepts integers from 1 to 500. Pages run newest
first by timestamp and position. Resume with the same tenant and pass
`nextCursor` as `olderThan`. The next page starts strictly before that cursor.
A `null` cursor means the query found no further rows, and an empty page has an
empty body. Pages are independent reads of the live log. Writes or deletes
between requests can change the remaining results.

## What it refuses to do

Audit records describe supplied mutations and actors. Application policies decide which records each caller may see.

## Contract

The trigger records identity columns and before and after row images as JSON
objects. Request and diagnostic context follows the client context contract.
Captured client hint headers are stored as string values. The reader returns
the newest rows first. Pass the last row's cursor to continue paging.

### Install in an API

`createAuditPlugin` declares the audit migrations, exclusions, and scope columns.
Provide a database, clock, and logger through `auditDepsService`. Include
`audit.audit` in the API services to read `auditService`. List `audit.routes`
under routes to accept client diagnostics, and list `audit.jobs` under jobs
on the host that runs retention. All three selections share one set of
services per API.

Pass `api.migrationSources(root)` to the migration workspace. The package
ships its TypeScript baseline migration with a stable journal name and checksum.
Use those sources once per migration workspace. For applications calling
`installAuditSchemaV1` in their own bootstrap migration, that bootstrap owns
the audit schema and the same workspace does not list the audit plugin source.
An application migration can use `configurePluginAuditTriggers` from
`@dads-framework/audit/schema` with the composed audit policy and table keys.
Keep the policy referenced by an applied migration stable.
