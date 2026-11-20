export {
  pendingAuthorizationMigrationIds,
  readAppliedAuthorizationMigrationIds,
  runAuthorizationMigrations,
  type AuthorizationJournalMarkerReader,
  type AuthorizationMigrationsLog,
  type RunAuthorizationMigrationsOptions,
} from "./lib/run-authorization-migrations.js";
export {
  JOURNAL_DEFINITION,
  listShippedAuthorizationMigrationIds,
  loadJournal,
} from "./lib/journal/load-journal.js";
export type {
  AuthorizationMigration,
  AuthorizationMigrationClient,
  AuthorizationMigrationStep,
  AuthorizationMigrationStore,
  LoadedAuthorizationMigration,
} from "./lib/journal/journal-entry.js";
export {
  classifySchemaDiff,
  type SchemaDiffClassification,
} from "./lib/logic/classify-schema-diff.js";
export {
  scaffoldMigration,
  type ScaffoldMigrationInput,
  type ScaffoldMigrationResult,
} from "./lib/scaffold/scaffold-migration.js";
export { buildMigrationBridgeSchema } from "./lib/scaffold/build-migration-bridge-schema.js";
export {
  planRenumber,
  renumberMigration,
  rewriteMigrationId,
  type RenumberMigrationInput,
  type RenumberMigrationResult,
  type RenumberPlan,
} from "./lib/scaffold/renumber-migration.js";
export {
  loadAuthorizationChanges,
  type AuthorizationChangeHooks,
  type LoadedAuthorizationChange,
} from "./lib/journal/load-authorization-changes.js";
export {
  AuthorizationChangeError,
  applyAuthorizationDefinitionPatches,
  authorizationChangeFrontier,
  authorizationSchemaDefinitions,
  canonicalAuthorizationSchema,
  composeAuthorizationChanges,
  orderAuthorizationChanges,
  type AuthorizationDefinitionPatch,
  type AuthorizationSchemaChange,
} from "./definition-changes.mjs";
export {
  scaffoldAuthorizationChange,
  type ScaffoldAuthorizationChangeInput,
  type ScaffoldAuthorizationChangeResult,
} from "./lib/scaffold/scaffold-authorization-change.js";
export { readAuthorizationMigrationStatus } from "./lib/journal/read-authorization-migration-status.js";
