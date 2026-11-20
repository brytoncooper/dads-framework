import {
  attachAuditTrigger,
  requireAuditIdentifier,
  type AuditTriggerMigrationBuilder,
  type AuditTriggerOptions,
} from "./attach-audit-trigger.js";
import { AUDIT_TRIGGER_ALLOWLIST } from "./audit-trigger-allowlist.js";

export type AuditTriggerConfiguration = {
  readonly tables: Readonly<Record<string, AuditTriggerOptions>>;
  readonly excludeTables?: readonly string[];
};

/** Reconciles the audit trigger on each application table named by the migration. */
export function configureAuditTriggers(
  pgm: AuditTriggerMigrationBuilder,
  configuration: AuditTriggerConfiguration,
): void {
  const excluded = new Set<string>([
    ...AUDIT_TRIGGER_ALLOWLIST,
    ...(configuration.excludeTables ?? []),
  ]);
  for (const table of excluded) requireAuditIdentifier(table, "excluded table");
  const tables = new Set([
    ...Object.keys(configuration.tables),
    ...(configuration.excludeTables ?? []),
  ]);
  for (const table of tables) {
    requireAuditIdentifier(table, "table");
    pgm.sql(`DROP TRIGGER IF EXISTS audit_record ON public."${table}"`);
    const options = configuration.tables[table];
    if (!excluded.has(table) && options !== undefined) {
      attachAuditTrigger(pgm, table, {
        ...options,
        scopeColumns: options.scopeColumns ?? {},
      });
    }
  }
}
