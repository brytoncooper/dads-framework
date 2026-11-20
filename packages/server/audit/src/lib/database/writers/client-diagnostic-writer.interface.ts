import type { clientDiagnosticEvents } from "../generated-tables/client-diagnostic-events.tables.js";

/**
 * No behavior lives in this file. This abstract class is the port for storing
 * and pruning `client_diagnostic_events` — the type the recorder and the
 * retention sweep hold, and the injection token composition binds.
 * `DrizzleClientDiagnosticWriter` implements it; a fake stands in for unit
 * tests, which is what lets the recorder's rules be proved without a database.
 */
export type ClientDiagnosticRow = Readonly<
  Pick<
    typeof clientDiagnosticEvents.$inferSelect,
    | "id"
    | "occurredAt"
    | "fingerprint"
    | "kind"
    | "severity"
    | "name"
    | "message"
    | "frames"
    | "breadcrumbs"
    | "release"
    | "client"
    | "requestId"
    | "actorKind"
    | "actorId"
    | "context"
  >
>;

export abstract class ClientDiagnosticWriter {
  /** Store a batch as one statement. Returns how many rows were written. */
  abstract record(rows: readonly ClientDiagnosticRow[]): Promise<number>;

  /**
   * Delete every row recorded strictly before `cutoff`, returning the count.
   * The table is allowlisted out of the `audit_record` trigger, so this
   * produces no `audit_log` row.
   */
  abstract deleteRecordedBefore(cutoff: Date): Promise<number>;
}
