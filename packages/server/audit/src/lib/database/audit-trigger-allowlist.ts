/** Audit-owned tables that never receive the row audit trigger. */
export const AUDIT_TRIGGER_ALLOWLIST = [
  "audit_log",
  "request_log",
  "client_diagnostic_events",
  "known_fault_fingerprints",
] as const;

export type AuditTriggerAllowlistEntry = (typeof AUDIT_TRIGGER_ALLOWLIST)[number];
