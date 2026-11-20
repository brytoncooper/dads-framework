# @dads-framework/authorization-migration — the authorization schema journal

Change a SpiceDB schema without interrupting live access. The runner applies
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

## Plan a change

1. Keep the current schema and journal under version control. Use
   `scaffoldAuthorizationChange` for a dependency-ordered patch, or
   `scaffoldMigration` for an entry containing a complete schema snapshot.
2. Put tuple moves or backfills before the schema removes the old relations.
   Check the pending IDs with `pendingAuthorizationMigrationIds`.
3. Run `runAuthorizationMigrations` from the deployment job with your journal,
   its folder, the authorized SpiceDB store, and the deployment logger. Read
   the applied markers before a repeat run.
