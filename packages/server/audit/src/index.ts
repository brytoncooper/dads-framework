export {
  attachAuditTrigger,
  detachAuditTrigger,
  type AuditTriggerMigrationBuilder,
  type AuditTriggerOptions,
} from "./lib/database/attach-audit-trigger.js";
export { up as installAuditSchemaV1 } from "./lib/database/migrations/20260910233455_audit.migration.js";
export {
  AUDIT_TRIGGER_ALLOWLIST,
  type AuditTriggerAllowlistEntry,
} from "./lib/database/audit-trigger-allowlist.js";
export {
  AuditLogReader,
  type AuditLogCursor,
  type AuditLogRecord,
  type AuditLogRowFilter,
  type AuditLogScope,
} from "./lib/database/readers/audit-log-reader.interface.js";
export { DrizzleAuditLogReader } from "./lib/database/readers/drizzle-audit-log-reader.js";
export {
  RequestLogReader,
  type RefusedRequest,
  type RefusedRequestFilter,
  type RequestLogCursor,
  type RequestLogEntry,
} from "./lib/database/readers/request-log-reader.interface.js";
export { DrizzleRequestLogReader } from "./lib/database/readers/drizzle-request-log-reader.js";
export {
  type AuditLogPosition,
  parseAuditLogPosition,
} from "./lib/database/audit-log-position.ids.js";
export { auditLog } from "./lib/database/generated-tables/audit-log.tables.js";
export { requestLog } from "./lib/database/generated-tables/request-log.tables.js";
export { clientDiagnosticEvents } from "./lib/database/generated-tables/client-diagnostic-events.tables.js";
export { knownFaultFingerprints } from "./lib/database/generated-tables/known-fault-fingerprints.tables.js";
export {
  insertForeignClientFaults,
  insertForeignRequestRows,
  type ForeignRowsHandle,
} from "./lib/request-log/insert-foreign-rows.js";
export {
  PostgresRequestLogSink,
  type PostgresRequestLogSinkOptions,
  type RequestLogSinkLog,
} from "./lib/request-log/postgres-request-log-sink.js";
export {
  composeSubjectToAuditActor,
  USER_SUBJECT_TYPE,
  type ActorForSubject,
  type ResolvedSubject,
} from "./lib/actor/compose-subject-to-audit-actor.js";
export {
  ALERT_NEW_FAULTS_JOB,
  createAlertNewFaultsJob,
  type CreateAlertNewFaultsJobDeps,
} from "./lib/fault-alerts/alert-new-faults.job.js";
export { newFaultsEmailTemplate } from "./lib/fault-alerts/new-faults.email-template.js";
export { DrizzleFaultAlertReader } from "./lib/database/readers/drizzle-fault-alert-reader.js";
export {
  type AlertedFault,
  FaultAlertReader,
  type FaultGroup,
  type FaultOrigin,
} from "./lib/database/readers/fault-alert-reader.interface.js";
export {
  composeAudit,
  type AssembledAudit,
  type ComposeAuditDeps,
} from "./lib/compose-audit.js";
export {
  configureAuditTriggers,
  type AuditTriggerConfiguration,
} from "./lib/database/configure-audit-triggers.js";
export type { AuditScopeValues } from "./lib/database/audit-row-json.js";
export {
  auditDepsService,
  auditService,
  createAuditPlugin,
  type AuditPluginOptions,
  type AuditServices,
} from "./lib/audit-plugin.js";
export { configurePluginAuditTriggers } from "./lib/database/configure-plugin-audit-triggers.js";
