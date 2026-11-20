# @dads-framework/migrations — the Postgres migration runner

Applies `<utcTimestamp>_<slug>.migration.ts` files (node-pg-migrate builders)
to a database and keeps a journal of what ran. It validates the checked-in
journal, keeps its immutable legacy prefix, checksums every applied file, takes
an advisory lock, and applies pending dependency (`dependsOn`) migrations in one
transaction. A file exporting `ownTransaction` commits alone; a file exporting
`buildsIndexesConcurrently` runs only concurrent index statements, outside any
transaction. Independent migrations keep stable filenames when another branch
deploys first. The runner obtains its dedicated Postgres session from
`@dads-framework/postgres` and closes it at the end of the run.

Where migrations live is the caller's to say. A `MigrationWorkspace` names a
root, the folders to walk (each with the pattern that picks out its migration
files and its owner), and the module aliases a migration may import.
`defaultMigrationWorkspace(root)` is this repository's layout: every server
part's `src/lib/**/migrations/` folder, plus an optional top-level
`migrations/` folder owned by `app`.

`@dads-framework/migrations/journal-status` is the read-only view for
reporting: the migration files a build ships and the database's applied
journal, without bundling the runner or node-pg-migrate.

## Commands

Each reads `DATABASE_URL` and `WORKSPACE_ROOT` (default `.`) and uses the
default workspace. `dads-migration-check` uses the Postgres testing export
to start an isolated container and requires the optional Testcontainers
dependencies of `@dads-framework/postgres`.

| Bin                    | What it does                                                                     |
| ---------------------- | -------------------------------------------------------------------------------- |
| `dads-migrate`         | apply every pending migration                                                    |
| `dads-migrate-adopt`   | record a leftover schema as applied, only when it equals what the journal builds |
| `dads-migrate-status`  | print `current`, `node-pg-pending`, `legacy-pending`, or a refusal               |
| `dads-migration-new`   | scaffold a migration for an owner, depending on the current frontier             |
| `dads-migration-check` | rehearse added migrations against a pinned base commit in a throwaway Postgres   |

## Try it

```sh
npm exec -- dads-migrate-status
```

## What it refuses to do

The runner uses a declared migration workspace. It refuses mismatched applied checksums before updating the schema.
