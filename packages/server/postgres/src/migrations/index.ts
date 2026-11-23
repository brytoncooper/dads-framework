export {
  describeMigrationFailure,
  type MigrationFailure,
} from "./lib/logic/describe-migration-failure.js";
export {
  parseMigrationEnvironment,
  type MigrationEnvironment,
} from "./lib/logic/parse-migration-environment.js";
export { discoverDomainMigrations } from "./lib/node-pg/discover-domain-migrations.js";
export type {
  DiscoverDomainMigrationsInput,
  DiscoveredDomainMigration,
  DomainMigration,
  DomainMigrationFunction,
} from "./lib/node-pg/domain-migration.js";
export { fileSha256 } from "./lib/node-pg/migration-checksum.js";
export { inspectNodePgMigrations } from "./lib/node-pg/inspect-node-pg-migrations.js";
export { planMigrationOrder } from "./lib/node-pg/plan-migration-order.js";
export {
  NODE_PG_APPLIED_TABLE,
  NODE_PG_CHECKSUM_TABLE,
  NODE_PG_JOURNAL_SCHEMA,
  NodePgMigrationJournalError,
  runNodePgMigrations,
  stampNodePgJournalAsApplied,
} from "./lib/node-pg/run-node-pg-migrations.js";
export {
  runDatabaseMigrations,
  type MigrationLog,
  type RunDatabaseMigrationsInput,
} from "./lib/run-database-migrations.js";
export {
  defaultMigrationWorkspace,
  type MigrationSource,
  type MigrationWorkspace,
} from "./lib/node-pg/migration-workspace.js";
export {
  EquivalentSchemaMismatchError,
  stampJournalWhenSchemaMatches,
} from "./lib/stamp-journal-when-schema-matches.js";
