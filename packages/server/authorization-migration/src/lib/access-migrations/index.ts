export {
  diffAccessIr,
  diffAccessModels,
  type AccessModelBreakingChange,
  type AccessModelDiff,
  type AccessModelSafeChange,
  type PermissionChangeSummary,
} from "./diff-access-models.js";
export {
  copyParent,
  copyRole,
  defineAccessMigration,
  dropParent,
  dropRole,
  type AccessMigrationRoleInput,
  type AccessMigrationStepBuilders,
  type AccessMigrationStepOp,
  type AccessRoleRef,
  type DefineAccessMigrationInput,
  type DefinedAccessMigration,
} from "./define-access-migration.js";
export {
  DEFAULT_MIGRATIONS_TABLE,
  DEFAULT_RELATIONSHIP_TABLE,
  createSqliteMigrationExecutor,
  type AccessMigrationRunResult,
  type PgMigrationClient,
  type PgMigrationExecutor,
  type PgMigrationPoolClient,
  type PgMigrationQueryResult,
  type PgMigrationRow,
  type SqliteMigrationExecutor,
  type SqliteMigrationRow,
  type SqliteMigrationValue,
  type SqliteSyncDatabaseLike,
  type SqliteSyncStatementLike,
} from "./sql-migration-types.js";
export {
  runPostgresAccessMigrations,
  type RunPostgresAccessMigrationsOptions,
} from "./run-postgres-access-migrations.js";
export {
  runSqliteAccessMigrations,
  type RunSqliteAccessMigrationsOptions,
} from "./run-sqlite-access-migrations.js";
export {
  assertAccessMigrationsUpToDate,
  type AccessMigrationRef,
  type AssertAccessMigrationsResult,
  type AssertAccessMigrationsUpToDateOptions,
} from "./assert-access-migrations-up-to-date.js";
export {
  applyAccessMigrationOpsToSpiceDb,
  runSpiceDbAccessMigrations,
  type RunSpiceDbAccessMigrationsOptions,
} from "./run-spicedb-access-migrations.js";
