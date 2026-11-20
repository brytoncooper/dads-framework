export {
  createAttributedPool,
  stampClientWithActor,
  type ActorStampableClient,
  type AuditActorSource,
} from "./lib/attributed-pool.js";
export { bytea } from "./lib/bytea-column.js";
export {
  connectPostgresClient,
  type PostgresClient,
  type PostgresQueryConfig,
  type PostgresQueryResult,
  type PostgresQueryResultRow,
} from "./lib/connect-postgres-client.js";
export { inet } from "./lib/inet-column.js";
export {
  createPostgresConnection,
  type CreatePostgresConnectionOptions,
  type PostgresConnection,
  type PostgresPoolErrorLog,
} from "./lib/create-postgres-connection.js";
export type { DrizzleHandle } from "./drizzle.js";
export {
  eventActorColumns,
  type EventActorColumns,
  type PersistedEventActor,
} from "./lib/event-actor-columns.js";
export {
  loadPageAndTotal,
  sqlOffsetForPage,
} from "./lib/load-page-and-total.js";
export { isUniqueViolation } from "./lib/unique-violation.js";
export {
  applySyncedRows,
  excluded,
  excludedAll,
  newerOrDifferent,
  sqlStateOf,
  SYNCED_ROW_IMMUTABLE_DIFFERS,
  SYNCED_VALUE_UNKNOWN,
  type SyncedRowChange,
  type SyncedRowOutcome,
  type SyncedRowTransaction,
  type SyncedRowWriter,
} from "./lib/synced-rows.js";
export { xid8 } from "./lib/xid8-column.js";
export { updateAtRowVersion } from "./lib/update-at-row-version.js";
