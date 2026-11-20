# @dads-framework/audit

Find who changed an audited row, what changed, and which request caused it.
The kit also records requests and client diagnostics. `composeAudit` wires
their retention jobs and diagnostic route to the application's services.

## Configure row auditing

Apply the audit kit migrations before configuring triggers from an application
migration. Declare each application table's identity columns and map any scope
dimensions to its columns. List application tables that should be excluded
from persistent audit history, such as temporary credential storage.

```ts
import { configureAuditTriggers } from "@dads-framework/audit/schema";

configureAuditTriggers(pgm, {
  tables: {
    documents: {
      keyColumns: ["id"],
      scopeColumns: { workspace: "workspace_key", project: "project_key" },
    },
  },
  excludeTables: ["temporary_tokens"],
});
```

The migration reconciles each named table's trigger in the public schema.
Name new tables in their own application migration. Audit-owned tables are
always excluded from this configuration. Configuration changes affect future
writes. The kit keeps previously recorded audit entries intact.

## Read the audit trail

Capture dimensions from the affected row at write time. Read them with
`{ kind: "application", values: { workspace: "example" } }`. All supplied
dimensions must match, and an empty scope matches nothing. An update that
changes a dimension is excluded from reads constrained by that dimension, so
a scope never exposes the other scope's row image. A platform read includes those updates.

Wrap writes in an audit actor context or use the attributed Postgres pool
from an application request or job. Applications can supply their own actor
kinds and request attribution. An audited write without an actor stamp
fails before it commits.

The trigger records identity columns and before and after row images as JSON
objects. Request and diagnostic context follows the client context contract.
Captured client hint headers are stored as string values.

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

## Install in an API

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
