export {
  attachAuditTrigger,
  detachAuditTrigger,
} from "./lib/database/attach-audit-trigger.js";
export { up as installAuditSchemaV1 } from "./lib/database/migrations/20260910233455_audit.migration.js";
export {
  configureAuditTriggers,
  type AuditTriggerConfiguration,
} from "./lib/database/configure-audit-triggers.js";
export type { AuditScopeValues } from "./lib/database/audit-row-json.js";
export { configurePluginAuditTriggers } from "./lib/database/configure-plugin-audit-triggers.js";
