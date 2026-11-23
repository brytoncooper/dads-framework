# @dads-framework/postgres/migrations — the Postgres migration runner

Deploy schema changes in a repeatable order and check which migrations each
database has applied. The runner applies `<utcTimestamp>_<slug>.migration.ts`
files built with node-pg-migrate and records them in a journal. It validates the checked-in
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

`applicationMigrationWorkspace(root, options?)` is the standard layout for
applications: an optional top-level `migrations/*.migration.ts` folder owned by
`app`, optional per-domain folders at `domains/*/server/migrations/` and
`domains/*/server/src/lib/database/migrations/` owned by the domain directory
name, plus optional `extraSources` (such as framework package migrations) and
`moduleAliases`.

`@dads-framework/postgres/migrations/journal-status` is the read-only view for
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

In a Node.js 22+ project, install the runner and create a migration.

```sh
npm install @dads-framework/postgres node-pg-migrate
mkdir -p migrations
cat > migrations/20260101000000_create_notes.migration.ts <<'EOF'
import type { MigrationBuilder } from "node-pg-migrate";

export const dependsOn = [];

export function up(pgm: MigrationBuilder) {
  pgm.createTable("notes", { id: { type: "serial", primaryKey: true } });
}

export function down(pgm: MigrationBuilder) {
  pgm.dropTable("notes");
}
EOF
```

Set `DATABASE_URL` to an empty PostgreSQL database where your role can
create schemas and tables. From the project root, save this as
`example.mts` and run `node --experimental-strip-types example.mts`.

<!-- dads:check-example -->

```ts
import { runNodePgMigrations } from "@dads-framework/postgres/migrations";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) throw new Error("Set DATABASE_URL");

await runNodePgMigrations({
  databaseUrl,
  workspace: {
    root: process.cwd(),
    sources: [
      {
        root: "migrations",
        files: /^migrations\/[^/]+\.migration\.ts$/,
        owner: "app",
        required: true,
      },
    ],
    moduleAliases: {},
  },
});
console.log("Migrations complete");
```

The first run creates the `notes` table and records the migration in the
journal. Running the script again skips the recorded migration.

In the generated app, `assembly/migrations.ts` points the runner at
`migrations/`. [Starter runner](../../../../apps/kit-workbench/assembly/migrations.ts) · [Starter schema migration](../../../../apps/kit-workbench/migrations/20261120080000_starter.migration.ts)

## What it refuses to do

The runner uses a declared migration workspace. It refuses mismatched applied checksums before updating the schema.
