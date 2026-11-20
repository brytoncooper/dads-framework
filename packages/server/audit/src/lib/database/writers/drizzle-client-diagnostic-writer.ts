import { lt } from "drizzle-orm";

import type { DrizzleHandle } from "@dads-framework/postgres";

import { clientDiagnosticEvents } from "../generated-tables/client-diagnostic-events.tables.js";
import type { ClientDiagnosticWriter } from "./client-diagnostic-writer.interface.js";
import { type ClientDiagnosticRow } from "./client-diagnostic-writer.interface.js";

/** Drizzle adapter for client diagnostic storage and its retention sweep. */
export class DrizzleClientDiagnosticWriter implements ClientDiagnosticWriter {
  constructor(private readonly db: DrizzleHandle) {}

  async record(rows: readonly ClientDiagnosticRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    // One statement for the batch: a page that failed several ways at once
    // reports once, and storing it costs one round trip rather than twenty.
    const written = await this.db
      .insert(clientDiagnosticEvents)
      .values(
        rows.map((row) => ({
          id: row.id,
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
    return written.length;
  }

  async deleteRecordedBefore(cutoff: Date): Promise<number> {
    const deleted = await this.db
      .delete(clientDiagnosticEvents)
      .where(lt(clientDiagnosticEvents.recordedAt, cutoff))
      .returning({ id: clientDiagnosticEvents.id });
    return deleted.length;
  }
}
