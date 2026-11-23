import type { DrizzleHandle } from "@dads-framework/postgres";

import { clientDiagnosticEvents } from "../database/generated-tables/client-diagnostic-events.tables.js";
import { requestLog } from "../database/generated-tables/request-log.tables.js";

/**
 * A database handle or an open transaction on it, so a caller can commit
 * these rows together with its own bookkeeping row.
 */
export type ForeignRowsHandle = DrizzleHandle | Parameters<Parameters<DrizzleHandle["transaction"]>[0]>[0];

/**
 * Inserts `request_log` rows recorded by another process of the same product
 * (a remote instance), already tagged by the caller. Idempotent by primary key:
 * a row whose `request_id` exists is skipped. Answers how many rows were new.
 */
export async function insertForeignRequestRows(
  db: ForeignRowsHandle,
  rows: readonly (typeof requestLog.$inferInsert)[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await db
    .insert(requestLog)
    .values(
      rows.map((row) => ({
        requestId: row.requestId,
        imported: true,
        recordedAt: row.recordedAt,
        method: row.method,
        routeId: row.routeId,
        path: row.path,
        status: row.status,
        durationMs: row.durationMs,
        actorKind: row.actorKind,
        actorId: row.actorId,
        authMethod: row.authMethod,
        accessKind: row.accessKind,
        permission: row.permission,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        decision: row.decision,
        errorCode: row.errorCode,
        ip: row.ip,
        forwardedFor: row.forwardedFor,
        userAgent: row.userAgent,
        clientHints: row.clientHints,
        acceptLanguage: row.acceptLanguage,
        clientContext: row.clientContext,
        apiRelease: row.apiRelease,
        dbQueryCount: row.dbQueryCount,
        dbMs: row.dbMs,
        authzCheckCount: row.authzCheckCount,
        authzMs: row.authzMs,
        instanceId: row.instanceId,
        exceptionType: row.exceptionType,
        exceptionFingerprint: row.exceptionFingerprint,
        traceId: row.traceId,
        authzCachedReadCount: row.authzCachedReadCount,
        authzFullyConsistentReadCount: row.authzFullyConsistentReadCount,
        authzLargestLookupCount: row.authzLargestLookupCount,
      })),
    )
    .onConflictDoNothing({ target: requestLog.requestId })
    .returning({ id: requestLog.requestId });
  return inserted.length;
}

/**
 * Inserts `client_diagnostic_events` rows recorded by another process of the
 * same product (a remote instance), already tagged by the caller. Idempotent by
 * primary key. Answers how many rows were new.
 */
export async function insertForeignClientFaults(
  db: ForeignRowsHandle,
  rows: readonly (typeof clientDiagnosticEvents.$inferInsert)[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await db
    .insert(clientDiagnosticEvents)
    .values(
      rows.map((row) => ({
        id: row.id,
        recordedAt: row.recordedAt,
        occurredAt: row.occurredAt,
        fingerprint: row.fingerprint,
        kind: row.kind,
        severity: row.severity,
        name: row.name,
        message: row.message,
        frames: row.frames,
        breadcrumbs: row.breadcrumbs,
        release: row.release,
        client: row.client,
        requestId: row.requestId,
        actorKind: row.actorKind,
        actorId: row.actorId,
        context: row.context,
      })),
    )
    .onConflictDoNothing({ target: clientDiagnosticEvents.id })
    .returning({ id: clientDiagnosticEvents.id });
  return inserted.length;
}
