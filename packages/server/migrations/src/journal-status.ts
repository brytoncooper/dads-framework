/**
 * Read-only view of what a build ships and what a database ran, for
 * reporting (`@dads-framework/migrations/journal-status`). A separate
 * entry so a reader such as the API never bundles the runner: nothing behind
 * it imports node-pg-migrate or the migration module loader.
 */
export type { ShippedDatabaseMigrationFile } from "./lib/node-pg/domain-migration.js";
export {
  type AppliedNodePgMigration,
  type NodePgJournalQueryClient,
  readAppliedNodePgJournal,
} from "./lib/node-pg/node-pg-journal.js";
export { listShippedDatabaseMigrations } from "./lib/node-pg/shipped-migration-files.js";
export {
  defaultMigrationWorkspace,
  type MigrationWorkspace,
} from "./lib/node-pg/migration-workspace.js";
