# @dads-framework/authorization-migration — the authorization schema journal

Moves a SpiceDB schema forward the way the database migrator moves Postgres:
an ordered journal of `NNNN_slug` entries, each holding the full `schema.zed`
snapshot it writes and the relationship steps that keep access intact (backfill
or move first, then delete). The runner refuses gaps, duplicates, folders
missing from the journal, and a snapshot that drops the journal's own
definition. Applied entries are recorded as `authz/migration_version`
relationships, so a rerun is a no-op.

Authorization changes (`authz-changes/`) are the patch form: each records the
definitions it changes and what it depends on, so two branches can add changes
without renumbering a shared index. `scaffoldMigration` and
`scaffoldAuthorizationChange` author new entries; `renumberMigration` moves an
entry that collided with another branch.

The journal folder is the caller's: nothing here assumes where it lives.
