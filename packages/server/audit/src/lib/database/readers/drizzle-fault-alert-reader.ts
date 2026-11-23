import { and, count, eq, gte, isNotNull, max, ne, notExists, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";

import type { DrizzleHandle } from "@dads-framework/postgres";

import { clientDiagnosticEvents } from "../generated-tables/client-diagnostic-events.tables.js";
import { knownFaultFingerprints } from "../generated-tables/known-fault-fingerprints.tables.js";
import { requestLog } from "../generated-tables/request-log.tables.js";
import type { FaultAlertReader } from "./fault-alert-reader.interface.js";
import { type AlertedFault, type FaultGroup, type FaultOrigin } from "./fault-alert-reader.interface.js";

/**
 * Drizzle adapter for "what is newly broken".
 *
 * Both reads are the same shape: everything inside the window, grouped by
 * fingerprint, minus what `known_fault_fingerprints` says has already been
 * reported. The window bounds the work — it is a range scan on `recorded_at`
 * rather than a group over the whole table — and the memory bounds the noise.
 * Neither alone is enough: the window cannot tell a returning fault from a new
 * one once the old rows are pruned, and the memory cannot tell a fault that is
 * happening now from one that stopped last spring.
 *
 * `max(...)` picks a representative route or release rather than listing every
 * one: the alert's job is to say something is newly broken and roughly where,
 * and the fingerprint is the handle for looking properly.
 */
export class DrizzleFaultAlertReader implements FaultAlertReader {
  constructor(private readonly db: DrizzleHandle) {}

  async unalertedServerFaultsSince(since: Date): Promise<readonly FaultGroup[]> {
    const rows = await this.db
      .select({
        fingerprint: requestLog.exceptionFingerprint,
        type: max(requestLog.exceptionType),
        occurrences: count(),
        where: max(requestLog.routeId),
      })
      .from(requestLog)
      .where(
        and(
          isNotNull(requestLog.exceptionFingerprint),
          gte(requestLog.recordedAt, since),
          this.notRemembered("server", requestLog.exceptionFingerprint),
        ),
      )
      .groupBy(requestLog.exceptionFingerprint);
    return rows.map(toFaultGroup);
  }

  async unalertedClientFaultsSince(since: Date): Promise<readonly FaultGroup[]> {
    const rows = await this.db
      .select({
        fingerprint: clientDiagnosticEvents.fingerprint,
        type: max(clientDiagnosticEvents.kind),
        occurrences: count(),
        where: max(clientDiagnosticEvents.release),
      })
      .from(clientDiagnosticEvents)
      .where(
        and(
          gte(clientDiagnosticEvents.recordedAt, since),
          // An info row is a measurement (the first-screen time), not a fault.
          ne(clientDiagnosticEvents.severity, "info"),
          this.notRemembered("client", clientDiagnosticEvents.fingerprint),
        ),
      )
      .groupBy(clientDiagnosticEvents.fingerprint);
    return rows.map(toFaultGroup);
  }

  async hasRememberedAnyFault(): Promise<boolean> {
    const rows = await this.db
      .select({ fingerprint: knownFaultFingerprints.fingerprint })
      .from(knownFaultFingerprints)
      .limit(1);
    return rows.length > 0;
  }

  async rememberFaultsSeenBefore(before: Date): Promise<number> {
    const seeded = await this.db.execute(sql`
      INSERT INTO ${knownFaultFingerprints} (origin, fingerprint)
      SELECT 'server', ${requestLog.exceptionFingerprint}
        FROM ${requestLog}
       WHERE ${requestLog.exceptionFingerprint} IS NOT NULL
         AND ${requestLog.recordedAt} < ${before}
       GROUP BY ${requestLog.exceptionFingerprint}
      UNION
      SELECT 'client', ${clientDiagnosticEvents.fingerprint}
        FROM ${clientDiagnosticEvents}
       WHERE ${clientDiagnosticEvents.recordedAt} < ${before}
       GROUP BY ${clientDiagnosticEvents.fingerprint}
      ON CONFLICT DO NOTHING
    `);
    return seeded.rowCount ?? 0;
  }

  async rememberAlertedFaults(faults: readonly AlertedFault[]): Promise<void> {
    if (faults.length === 0) return;
    await this.db
      .insert(knownFaultFingerprints)
      .values(
        faults.map((fault) => ({
          origin: fault.origin,
          fingerprint: fault.fingerprint,
        })),
      )
      // Two workers can sweep the same hour; the second one has nothing to add.
      .onConflictDoNothing();
  }

  /**
   * The half of "new" that survives the fault tables being pruned.
   *
   * `NOT EXISTS` rather than a join so a fingerprint with a memory row costs
   * one probe of the composite primary key and stops, and so the grouped count
   * stays the fault's own however many memory rows exist.
   */
  private notRemembered(origin: FaultOrigin, fingerprint: AnyColumn): SQL {
    return notExists(
      this.db
        .select({ remembered: sql`1` })
        .from(knownFaultFingerprints)
        .where(and(eq(knownFaultFingerprints.origin, origin), eq(knownFaultFingerprints.fingerprint, fingerprint))),
    );
  }
}

/** Aggregates are nullable to SQL; a grouped row always has them. */
function toFaultGroup(row: {
  fingerprint: string | null;
  type: string | null;
  occurrences: number;
  where: string | null;
}): FaultGroup {
  return {
    fingerprint: row.fingerprint ?? "unknown",
    type: row.type ?? "unknown",
    occurrences: row.occurrences,
    where: row.where,
  };
}
