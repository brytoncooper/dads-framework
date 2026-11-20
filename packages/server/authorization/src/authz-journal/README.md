# `@dads-framework/authorization/authz-journal`

SpiceDB types for the authorization migration journal (`authz/migration_version`, `authz/migration_journal`).
The two journal access declarations are the source for
`../generated/authz-migration.zed`. The journal test compiles those declarations
and compares the emitted Zed with the checked-in file byte for byte. Run
`npm run verify:authorization` from the workspace root to check it.

Workbench's SpiceDB launcher emits its composed model directly at startup. The
Postgres adapter compiles the access model in memory. Those paths have no
checked-in schema artifact.
