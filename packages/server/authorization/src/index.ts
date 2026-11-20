export {
  ApplyAccessChanges,
  type ApplyAccessChangesInput,
  type ApplyAccessChangesReport,
} from "./lib/access-changes/apply.js";
export {
  ApplyAccessChangesAfterCommit,
  createApplyAccessChangesAfterCommit,
  DEFAULT_HELD_CLAIM_CHECKS,
  DEFAULT_HELD_CLAIM_INTERVAL_MS,
  type DispatchLog,
  type HeldClaimWait,
} from "./lib/access-changes/apply-after-commit.js";
export {
  ClaimAccessChanges,
  type ClaimedOutboxRow,
  type OutboxClaim,
  type OutboxCounts,
  type OutboxHeldKeysQuery,
  type OutboxKeyClaim,
} from "./lib/access-changes/claim.js";
export {
  CompleteAccessChanges,
  createCompleteAccessChanges,
  type CompleteAccessChangesInput,
} from "./lib/access-changes/complete.js";
export {
  AccessChangeCompletionStatusReader,
  RetryFailedAccessChanges,
  type UnfinishedAccessChange,
} from "./lib/access-changes/completion-status.js";
export {
  accessChangesToWrite,
  EnqueueAccessChanges,
  OUTBOX_OPERATION_VALUES,
  OUTBOX_STATUS_VALUES,
  outboxKeyForRelationship,
  type AccessChange,
  type OutboxOperation,
  type OutboxStatus,
  type OutboxTx,
} from "./lib/access-changes/enqueue.js";
export {
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  leaseCutoff,
  outcomeAfterFailure,
  summarizeError,
} from "./lib/access-changes/logic/claim-rules.js";
export { OwnerLock, OwnerLockLease } from "@dads-framework/access/runtime";
export { authorizationOutbox } from "./lib/access-changes/postgres/access-changes.tables.js";
export { PostgresClaimAccessChanges } from "./lib/access-changes/postgres/claim.js";
export { PostgresAccessChangeCompletionStatus } from "./lib/access-changes/postgres/completion-status.js";
export { PostgresEnqueueAccessChanges } from "./lib/access-changes/postgres/enqueue.js";
export {
  LOCK_HOLDER_FREE_CONNECTIONS,
  type LockConnectionPool,
  NESTED_LOCK_HOLDER_FREE_CONNECTIONS,
  PostgresOwnerLock,
  reserveLockConnection,
  runHoldingLockConnection,
} from "./lib/access-changes/postgres/owner-lock.js";
export { requeueFailedAccessChanges } from "./lib/access-changes/postgres/requeue-failed.js";
export {
  deleteRelationshipsNow,
  revokeAccess,
  type CommittedSynchronousRevocationInput,
  type RevocationLog,
  type RevokeThroughInput,
} from "./lib/access-changes/revoke.js";
export {
  stateSyncedRowRelationships,
  syncedRowWriterWithRelationships,
  type ReadSyncedRowRelationships,
  type SyncedRowOutbox,
  type SyncedRowRelationships,
} from "./lib/access-changes/synced-row-relationships.js";
export { AnswerOnceAuthorization } from "@dads-framework/access/runtime";
export {
  AUDIT_CATALOG_SIZES_JOB,
  auditCatalogSizes,
  CatalogOverSizeMarkError,
  createAuditCatalogSizesJob,
  type CreateAuditCatalogSizesJobDeps,
  type OversizedCatalog,
} from "./lib/catalog-sizes/audit-catalog-sizes.job.js";
export {
  CatalogSizeReader,
  PostgresCatalogSizeReader,
} from "./lib/catalog-sizes/catalog-size-reader.js";
export {
  catalogTable,
  catalogTableFailures,
  catalogWithoutTable,
  type CatalogTable,
  type CatalogTableDeclaration,
  type CatalogWithoutTable,
} from "./lib/catalog-sizes/catalog-tables.js";
export {
  type AuthorizationGuardMarks,
  DEFAULT_AUTHORIZATION_GUARD_MARKS,
  authorizationKinds,
  type EntityKindLookup,
  GuardedAuthorization,
  LookupOverHardCapError,
  RecordLookupRefusedError,
} from "./lib/access/guarded-authorization.js";
export {
  Authorization,
  relationshipWrite,
  type DirectSubjectLookup,
  type PermissionCheckOutcome,
  type PermissionQuery,
  type RelationshipFilter,
  type RelationshipWrite,
  type ResourceLookup,
  type ResourceRef,
  type SpiceDbConsistencyToken,
  type SubjectRef,
  type WireResourceRef,
} from "@dads-framework/access/runtime";
export {
  authorizationConsistencyTokenOnThisRequest,
  recordWrittenAuthorizationConsistency,
  runWithAuthorizationConsistency,
  writtenAuthorizationConsistencyOnThisRequest,
} from "@dads-framework/access/runtime";
export { checkAll } from "./lib/access/check-all.js";
export { listOnlyVisible } from "./lib/access/list-only-visible.js";
export {
  AUTHORIZATION_CONSISTENCY_COOKIE,
  authorizationConsistencyClearCookie,
  authorizationConsistencySetCookie,
  authorizationConsistencyTokenFromCookieHeader,
} from "@dads-framework/access/runtime";
export {
  MissingOwnershipTuples,
  type MissingOwnershipTuple,
} from "./lib/access/missing-ownership-tuples.js";
export {
  RequestSubject,
  type AuthMethod,
  type RequestHeaders,
  type ResolvedSubject,
} from "@dads-framework/access/runtime";
export {
  evaluateRouteAccess,
  type RouteAccessInput,
  type RouteAccessVerdict,
} from "@dads-framework/access/runtime";
export {
  createSpiceDbAuthorization,
  SpiceDbAuthorization,
  type SpiceDbAdapterOptions,
} from "./lib/access/spice-db-authorization.js";
export { TalliedAuthorization } from "./lib/access/tallied-authorization.js";
export {
  answerScope,
  planScopedList,
  scopeQuestionKey,
  scopeQuestions,
  type ScopeAnswer,
  type ScopeLookups,
  type ScopeQuestion,
} from "@dads-framework/access/runtime";
export { scopePredicate } from "./lib/scoped-lists/scope-predicate.js";
export {
  scopeSqlBindings,
  type DerivedSql,
  type RoleSql,
  type ScopeColumnSql,
  type ScopeJoinSql,
  type ScopeSqlBindings,
  type ScopeSqlRoles,
  type TagSql,
} from "./lib/scoped-lists/scope-sql-bindings.js";
export {
  keepPermitted,
  type PageCheck,
} from "./lib/scoped-lists/keep-permitted.js";
export type {
  RelationshipPage,
  RelationshipPageRequest,
} from "@dads-framework/access/runtime";
export {
  applyDesiredAuthorizationSchema,
  type ApplyAuthorizationSchemaLog,
  type ApplyAuthorizationSchemaReport,
} from "@dads-framework/access/schema";
export {
  SCHEMA_REWRITE_STEPS,
  type AuthorizationSchemaStore,
  type SchemaRewriteStep,
} from "@dads-framework/access/schema";
export {
  cloneSpiceDbDatastore,
  spiceDbDatastoreAdminUrl,
  spiceDbDatastoreDatabaseName,
} from "./lib/schema-migrate/clone-spice-db-datastore.js";
export {
  parseWriteSchemaBlocker,
  type WriteSchemaBlocker,
} from "@dads-framework/access/schema";
export {
  parseZedSchemaSurface,
  type ZedRelation,
  type ZedSchemaSurface,
} from "@dads-framework/access/schema";
export {
  contractionPlanIsEmpty,
  planSchemaContraction,
  type SchemaContractionPlan,
} from "@dads-framework/access/schema";
export {
  parseAuthorizationSchemaMigrationEnvironment,
  type AuthorizationSchemaMigrationEnvironment,
} from "./lib/schema-migrate/parse-authorization-schema-migration-environment.js";
