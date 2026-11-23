import type { MigrationWorkspace } from "./node-pg/migration-workspace.js";
import { runNodePgMigrations } from "./node-pg/run-node-pg-migrations.js";
import { stampJournalWhenSchemaMatches } from "./stamp-journal-when-schema-matches.js";

export type MigrationLog = {
  info(context: object, message: string): void;
};

export type RunDatabaseMigrationsInput = {
  readonly databaseUrl: string;
  readonly workspace: MigrationWorkspace;
};

/** Applies pending node-pg migrations. Stamps a leftover equal schema once. */
export async function runDatabaseMigrations(
  input: RunDatabaseMigrationsInput,
  log: MigrationLog,
): Promise<void> {
  const outcome = await stampJournalWhenSchemaMatches(
    input.databaseUrl,
    input.workspace,
  );
  if (outcome === "stamped") {
    log.info(
      {
        event: "database.migrate.journal-stamped",
        code: "DATABASE_MIGRATION_JOURNAL_STAMPED",
      },
      "leftover schema matched the journal and was recorded as applied",
    );
  }
  await runNodePgMigrations({
    databaseUrl: input.databaseUrl,
    workspace: input.workspace,
  });
  log.info(
    {
      event: "database.migrate.complete",
      code: "DATABASE_MIGRATION_COMPLETE",
    },
    "database is at the checked-in schema",
  );
}
