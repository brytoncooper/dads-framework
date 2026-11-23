#!/usr/bin/env node
import { stampJournalWhenSchemaMatches } from "../index.js";
import { migrationInputFromEnvironment, migrationLog, reportMigrationFailure } from "./migration-log.js";

/**
 * `dads-migrate-adopt`: records a leftover schema built before the journal
 * existed as applied, but only when it equals what the journal would build.
 */
async function adoptExistingSchema(): Promise<void> {
  const input = migrationInputFromEnvironment(process.env);
  const outcome = await stampJournalWhenSchemaMatches(input.databaseUrl, input.workspace);
  migrationLog.info(
    {
      event: "database.journal.adopt.complete",
      code: "DATABASE_JOURNAL_ADOPT_COMPLETE",
      outcome,
    },
    outcome === "stamped"
      ? "leftover schema matched the journal and was recorded as applied"
      : "no leftover unjournaled schema to stamp",
  );
}

adoptExistingSchema().catch((error: unknown) => {
  reportMigrationFailure(error, {
    event: "database.journal.adopt.failed",
    code: "DATABASE_JOURNAL_ADOPT_FAILED",
    message: "leftover schema adopt failed",
  });
});
