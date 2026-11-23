#!/usr/bin/env node
import { runDatabaseMigrations } from "../index.js";
import { migrationInputFromEnvironment, migrationLog, reportMigrationFailure } from "./migration-log.js";

/** `dads-migrate`: applies every pending migration to `DATABASE_URL`. */
async function migrateDatabase(): Promise<void> {
  await runDatabaseMigrations(migrationInputFromEnvironment(process.env), migrationLog);
}

migrateDatabase().catch((error: unknown) => {
  reportMigrationFailure(error, {
    event: "database.migrate.failed",
    code: "DATABASE_MIGRATION_FAILED",
    message: "database migration failed",
  });
});
