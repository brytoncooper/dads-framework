import { fileURLToPath } from "node:url";

import { definePlugin, defineService, type AuditSettings } from "@dads-framework/core/plugin";

import { composeAudit, type AssembledAudit, type ComposeAuditDeps } from "./compose-audit.js";
import { AUDIT_TRIGGER_ALLOWLIST } from "./database/audit-trigger-allowlist.js";
import type { AuditLogReader } from "./database/readers/audit-log-reader.interface.js";
import { DrizzleAuditLogReader } from "./database/readers/drizzle-audit-log-reader.js";
import { DrizzleRequestLogReader } from "./database/readers/drizzle-request-log-reader.js";
import type { RequestLogReader } from "./database/readers/request-log-reader.interface.js";

type AuditRetention = Pick<ComposeAuditDeps, "requestLogRetentionDays" | "clientDiagnosticsRetentionDays">;

export type AuditPluginOptions = AuditRetention & AuditSettings;

export type AuditServices = {
  readonly auditLog: AuditLogReader;
  readonly requestLog: RequestLogReader;
};

type AuditPluginRuntime = AuditServices & AssembledAudit;

export const auditDepsService =
  defineService("audit-dependencies").ofType<Omit<ComposeAuditDeps, keyof AuditRetention>>();

export const auditService = defineService("audit").ofType<AuditServices>();

/** Declare the audit policy once, then select routes and jobs independently. */
export function createAuditPlugin(options: AuditPluginOptions) {
  const { requestLogRetentionDays, clientDiagnosticsRetentionDays } = options;
  const audit = definePlugin<
    "audit",
    readonly [typeof auditDepsService],
    AuditPluginRuntime,
    never,
    never,
    never,
    "audit"
  >({
    name: "audit",
    requires: [auditDepsService],
    implements: auditService,
    contributes: {
      audit: {
        untrackedTables: [...AUDIT_TRIGGER_ALLOWLIST, ...(options.untrackedTables ?? [])],
        scopes: (options.scopes ?? []).map(({ table, columns }) => ({
          table,
          columns: { ...columns },
        })),
      },
      migrations: [
        {
          directory: fileURLToPath(new URL("../../src/lib/database/migrations/", import.meta.url)),
        },
      ],
    },
    setup: ({ use }) => {
      const deps = use(auditDepsService);
      const runtime: AuditPluginRuntime = {
        ...composeAudit({
          ...deps,
          requestLogRetentionDays,
          clientDiagnosticsRetentionDays,
        }),
        auditLog: new DrizzleAuditLogReader(deps.db),
        requestLog: new DrizzleRequestLogReader(deps.db),
      };
      return { provides: runtime };
    },
  });

  return {
    audit,
    routes: definePlugin({
      name: "audit-routes",
      requires: [audit],
      setup: ({ use }) => ({ routes: use(audit).routes }),
    }),
    jobs: definePlugin({
      name: "audit-jobs",
      requires: [audit],
      setup: ({ use }) => ({ jobs: use(audit).jobs }),
    }),
  };
}
