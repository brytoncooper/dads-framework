# Audit and migrations

Add auditing where application state changes. In the starter, a database
migration installs the audit schema and configures triggers for tenant
tables and `starter_note`. For a note, the trigger identifies the row by
`id` and records its tenant scope using `tenant_id`.
[Starter schema migration](../../../apps/kit-workbench/migrations/20261120080000_starter.migration.ts)

The HTTP host resolves the audit actor from the authenticated subject.
The database connection takes the current actor from the request context.
Follow both steps before adding an audited write. A trigger provides the
row change, and the connection carries who made it.
[Request actor wiring](../../../apps/kit-workbench/assembly/start-app.ts) ·
[Postgres connection wiring](../../../apps/kit-workbench/assembly/services.ts) ·
[Audit kit](../../../packages/server/audit/README.md)

## Add a migration safely

1. Add a forward migration in the application's registered source. Keep
   migrations that have already run unchanged.
   [Starter migration registry](../../../apps/kit-workbench/assembly/migrations.ts)
2. Apply it to a disposable Postgres database with `npm run migrate` from
   the starter. Use the existing-database setup for the required environment.
   If the change affects previously stored data, seed an old row and test
   the migration before trying a fresh install.
   [Starter database setup](../../../apps/kit-workbench/README.md#run-against-your-own-database)
3. Create or change a row through an authenticated request. Check the
   persisted audit record for the actor, resource ID, and tenant scope.
   Include a rollback test for transaction-sensitive writes.
   [Audit integration tests](../../../packages/server/audit/src/lib/database/audit-log.integration.test.ts)

Use the migration runner's ordering and compatibility checks as part of
deployment rehearsal. The notes plugin fixture shows how a plugin contributes
a migration directory for discovery.
[Migration runner](../../../packages/server/migrations/README.md) ·
[Plugin migration proof](../../../fixtures/plugin-notes/src/notes-plugin.test.ts)
