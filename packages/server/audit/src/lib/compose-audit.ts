import type { Clock } from "@dads-framework/runtime/clock";
import type { HttpRoute } from "@dads-framework/http";
import type { JobDefinition, JobLog } from "@dads-framework/job-queue";
import type { DrizzleHandle } from "@dads-framework/postgres";

import { ClientDiagnosticsRouteHandlers } from "./client-diagnostics/client-diagnostics.route-handlers.js";
import { createClientDiagnosticsRoutes } from "./client-diagnostics/client-diagnostics.routes.js";
import { RecordClientDiagnostics } from "./client-diagnostics/record-client-diagnostics.js";
import { DrizzleClientDiagnosticWriter } from "./database/writers/drizzle-client-diagnostic-writer.js";
import { DrizzleRequestLogWriter } from "./database/writers/drizzle-request-log-writer.js";
import { createPruneClientDiagnosticsJob } from "./jobs/prune-client-diagnostics.job.js";
import { createPruneRequestLogJob } from "./jobs/prune-request-log.job.js";

export type ComposeAuditDeps = {
  readonly db: DrizzleHandle;
  readonly clock: Clock;
  readonly log: JobLog;
  /** Days a `request_log` row survives before the daily prune job deletes it. */
  readonly requestLogRetentionDays: number;
  /** Days a reported client fault survives; shorter, because messages are free text. */
  readonly clientDiagnosticsRetentionDays: number;
};

export type AssembledAudit = {
  readonly jobs: readonly JobDefinition[];
  readonly routes: readonly HttpRoute[];
};

/**
 * Assembles the application's request retention, diagnostics retention, and
 * diagnostic reporting route using its database, clock, and log.
 *
 * The client-diagnostics route lives here rather than in a domain because
 * what it stores is the browser-side sibling of `request_log` — diagnostic
 * exhaust with a retention clock, not any domain's business history.
 */
export function composeAudit(deps: ComposeAuditDeps): AssembledAudit {
  const requestLogWriter = new DrizzleRequestLogWriter(deps.db);
  const clientDiagnosticWriter = new DrizzleClientDiagnosticWriter(deps.db);
  const clientDiagnostics = new ClientDiagnosticsRouteHandlers(
    new RecordClientDiagnostics(clientDiagnosticWriter, deps.log),
  );
  return {
    jobs: [
      createPruneRequestLogJob({
        writer: requestLogWriter,
        clock: deps.clock,
        retentionDays: deps.requestLogRetentionDays,
        log: deps.log,
      }),
      createPruneClientDiagnosticsJob({
        writer: clientDiagnosticWriter,
        clock: deps.clock,
        retentionDays: deps.clientDiagnosticsRetentionDays,
        log: deps.log,
      }),
    ],
    routes: createClientDiagnosticsRoutes(clientDiagnostics),
  };
}
