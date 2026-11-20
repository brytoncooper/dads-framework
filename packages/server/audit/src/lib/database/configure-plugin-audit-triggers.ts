import type { AuditScopeContribution } from "@dads-framework/plugin";

import type { AuditTriggerMigrationBuilder } from "./attach-audit-trigger.js";
import {
  configureAuditTriggers,
  type AuditTriggerConfiguration,
} from "./configure-audit-triggers.js";

type PluginAuditPolicy = {
  readonly auditScopes: readonly AuditScopeContribution[];
  readonly untrackedAuditTables: readonly string[];
};

/** Apply the selected plugins' audit policy to known application tables. */
export function configurePluginAuditTriggers(
  pgm: AuditTriggerMigrationBuilder,
  policy: PluginAuditPolicy,
  tables: AuditTriggerConfiguration["tables"],
): void {
  const configuredTables = { ...tables };
  for (const { table, columns } of policy.auditScopes) {
    const options = Object.hasOwn(tables, table) ? tables[table] : undefined;
    if (options === undefined) {
      throw new Error(`Audit scope declared for unknown table ${table}`);
    }
    if (options.scopeColumns !== undefined) {
      throw new Error(
        `Audit scope declared by both the application and a plugin for ${table}`,
      );
    }
    Object.defineProperty(configuredTables, table, {
      value: { ...options, scopeColumns: columns },
      enumerable: true,
    });
  }
  configureAuditTriggers(pgm, {
    tables: configuredTables,
    excludeTables: policy.untrackedAuditTables,
  });
}
