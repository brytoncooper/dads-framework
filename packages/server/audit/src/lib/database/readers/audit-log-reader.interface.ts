import type { AuditLogPosition } from "../audit-log-position.ids.js";
import type { AuditScopeValues } from "../audit-row-json.js";
import type { auditLog } from "../generated-tables/audit-log.tables.js";

/** Full audit history or rows matching every configured application scope dimension. */
export type AuditLogScope =
  | { readonly kind: "application"; readonly values: AuditScopeValues }
  | { readonly kind: "platform" };

/** Narrowing within a scope. Every field is optional and they combine with AND. */
export type AuditLogRowFilter = {
  /** Inclusive lower bound on `recorded_at`. */
  readonly from?: Date;
  /** Exclusive upper bound on `recorded_at`. */
  readonly to?: Date;
  /** The human behind the write (`user_id`). */
  readonly userId?: string;
  /** Stored `actor_kind` values; empty or absent means any. */
  readonly actorKinds?: readonly string[];
  /** Only these tables; empty or absent means any. */
  readonly tableNames?: readonly string[];
  /** Never these tables. */
  readonly excludeTableNames?: readonly string[];
  /**
   * Leave out one request's rows: a request too large to fit one page is
   * shown once, and the pages after it skip the rest of it.
   */
  readonly excludeRequestId?: string;
  /**
   * Leave out an update that changed nothing a reader is shown: for each
   * table named, the columns an update must change at least one of to be
   * listed. An update that touched only the others (`updated_at`, a sync
   * marker) is left out; inserts, deletes and updates to tables not named
   * are always kept.
   */
  readonly shownUpdateColumns?: Readonly<Record<string, readonly string[]>>;
  /** The history of one record. */
  readonly record?: {
    readonly tableName: string;
    readonly rowKey: Readonly<Record<string, unknown>>;
  };
};

/**
 * Where the previous page stopped: rows strictly older than this are next.
 *
 * `recordedAt` is the stored instant to the microsecond, as UTC text
 * (`2026-10-22T14:03:11.123456Z`). A `Date` keeps milliseconds only, and rows
 * of different transactions can share a millisecond, so a millisecond cursor
 * would skip or repeat them; the text round-trips the stored value exactly.
 */
export type AuditLogCursor = {
  readonly recordedAt: string;
  readonly position: AuditLogPosition;
};

/** A stored audit entry and the cursor required to resume its page. */
export type AuditLogRecord = Readonly<
  Pick<
    typeof auditLog.$inferSelect,
    | "scopeValues"
    | "position"
    | "recordedAt"
    | "actorKind"
    | "actorId"
    | "clientId"
    | "clientName"
    | "requestId"
    | "reason"
    | "userId"
    | "tableName"
    | "rowKey"
    | "changedColumns"
    | "rowBefore"
    | "rowAfter"
  >
> & {
  readonly operation: "insert" | "update" | "delete";
  readonly cursor: AuditLogCursor;
};

/**
 * No behavior lives in this file — it is not a wrapper or a pass-through.
 * This abstract class is the port for reading `audit_log`: the type
 * a caller holds AND the injection token composition binds.
 * `DrizzleAuditLogReader` (database/readers/) implements it; a fake stands in
 * for unit tests that never reach a database.
 */
export abstract class AuditLogReader {
  /**
   * Rows in the scope, newest first by `(recorded_at, position)`, strictly
   * older than `olderThan` when given, at most `limit` of them. Every scope
   * and filter combination is served by one index seek; nothing counts.
   */
  abstract listRows(
    scope: AuditLogScope,
    filter: AuditLogRowFilter,
    olderThan: AuditLogCursor | null,
    limit: number,
  ): Promise<readonly AuditLogRecord[]>;

  /** Every row one request wrote, oldest first. */
  abstract rowsForRequest(
    requestId: string,
  ): Promise<readonly AuditLogRecord[]>;

  /** Count distinct records changed by one request in the named scope. */
  abstract countRecordsForRequest(
    scope: AuditLogScope,
    requestId: string,
    filter: Pick<AuditLogRowFilter, "shownUpdateColumns">,
  ): Promise<number>;

  /** One row by its position, for a write that carried no request id. */
  abstract rowAt(position: AuditLogPosition): Promise<AuditLogRecord | null>;
}
