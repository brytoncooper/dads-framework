# Audit and migrations

The [audit kit](../../../packages/server/audit/README.md) records changes and
the actor who made them. Set the application actor at the request or job
boundary and ensure the write uses an attributed Postgres connection.

Use [the migration runner](../../../packages/server/migrations/README.md) to
discover ordered migrations and rehearse changes. Keep applied migrations
unchanged. To evolve a table or add an audit trigger, write a forward
migration and test what happens to existing rows as well as new rows.

The notes plugin supplies a migration directory. Read its
[migration discovery proof](../../../fixtures/plugin-notes/src/notes-plugin.test.ts)
before adding the same contribution to another plugin.
