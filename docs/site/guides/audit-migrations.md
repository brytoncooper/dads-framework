# Audit and migrations

Save a note through the customer API and find its audit entry through
the staff API. The starter's first migration installs the audit schema
and attaches row triggers to the tenant tables and notes.

## Record a change

Run the starter and create an **Alpha** workspace as its owner. Add a note
in the browser or submit this request with that account's session.

```http
POST /api/tenants/<alpha-id>/notes
Cookie: <owner-session-cookie>
Content-Type: application/json

{"text":"Prepare the handoff checklist"}
```

Expect `201 Created`. Save `data.id` to look up the persisted audit row.
The HTTP host supplies the account ID and request ID. The database
connection carries them into the write, and the trigger records an
`insert` on `starter_note` with these key and scope columns.

<!-- dads:excerpt {"path":"apps/kit-workbench/migrations/20261120080000_starter.migration.ts","language":"ts","from":"      starter_note: {","through":"        scopeColumns: { tenant_id: \"tenant_id\" },"} -->

On a disposable database with SQL access, inspect the persisted record.
Substitute the note ID from the response and compare `actor_id` to the
owner's account ID and `scope_values.tenant_id` to Alpha's ID.

```sh
psql "$DATABASE_URL" <<'SQL'
SELECT actor_kind, actor_id, request_id, row_key, scope_values
FROM audit_log
WHERE table_name = 'starter_note'
  AND operation = 'insert'
  AND row_key->>'id' = '<note-id>';
SQL
```

## Export the tenant's audit metadata

Run `npm run dev:status` to find the staff API origin. Send the request
to that origin with the owner session. Use a small page so you can
exercise the continuation.

```http
GET /api/tenants/<alpha-id>/audit-log/export?pageSize=1
Cookie: <owner-session-cookie>
```

Expect `200` with `Content-Type: application/x-ndjson` and
`Content-Disposition: attachment; filename="audit-log.ndjson"`. The note
entry contains the following fields among its metadata.

```json
{
  "actorKind": "account",
  "actorId": "<owner-account-id>",
  "requestId": "<request-id>",
  "tableName": "starter_note",
  "operation": "insert"
}
```

Follow `Link: <…>; rel="next"` if the response has more rows. Every page
checks Alpha's `manage_tenant` permission. Try the same continuation URL
with an ordinary Alpha member's session and expect `404`. The export
contains metadata only. The note text and row images stay in the database.

## Apply a forward migration

For a new audited table, add the table and its trigger configuration in
a new file under the starter's registered `migrations/` directory.
Follow the pattern above and choose the row key and tenant column for
that table. Keep applied files intact. Their checksums are recorded in
the database journal.

Point `DATABASE_URL` at a disposable database. For a change to an
existing table, first run the previous app revision against the database
and create a representative row through its API. Then run the new
revision's migrations from the starter root.

```sh
npm run migrate
```

Read the old row through the upgraded app. Create a new row and check
its actor, key, and tenant scope in the audit table. Rehearse a clean
install on a separate empty database. For a transaction-sensitive write,
force a rollback in a test and check that both the application row and
its audit entry are absent.

[Audit export proof](../../../apps/kit-workbench/tests/audit-export.test-support.ts) ·
[Audit database tests](../../../packages/server/audit/src/lib/database/audit-log.integration.test.ts) ·
[Migration runner](../../../packages/server/migrations/README.md)
