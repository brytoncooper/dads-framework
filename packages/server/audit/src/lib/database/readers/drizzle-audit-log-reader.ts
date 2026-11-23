import { and, asc, desc, eq, gte, inArray, lt, ne, notInArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias, type PgColumn } from "drizzle-orm/pg-core";

import type { DrizzleHandle } from "@dads-framework/postgres";

import type { AuditLogPosition } from "../audit-log-position.ids.js";
import { auditLog } from "../generated-tables/audit-log.tables.js";
import type { AuditLogReader } from "./audit-log-reader.interface.js";
import {
  type AuditLogCursor,
  type AuditLogRecord,
  type AuditLogRowFilter,
  type AuditLogScope,
} from "./audit-log-reader.interface.js";

/**
 * `recorded_at` to the microsecond as UTC text. A `Date` keeps milliseconds,
 * which is not enough to resume a keyset page exactly (see `AuditLogCursor`).
 */
const RECORDED_AT_EXACT = sql<string>`to_char(${auditLog.recordedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const ROW_COLUMNS = {
  scopeValues: auditLog.scopeValues,
  position: auditLog.position,
  recordedAt: auditLog.recordedAt,
  recordedAtExact: RECORDED_AT_EXACT,
  actorKind: auditLog.actorKind,
  actorId: auditLog.actorId,
  clientId: auditLog.clientId,
  clientName: auditLog.clientName,
  requestId: auditLog.requestId,
  reason: auditLog.reason,
  userId: auditLog.userId,
  tableName: auditLog.tableName,
  rowKey: auditLog.rowKey,
  operation: auditLog.operation,
  changedColumns: auditLog.changedColumns,
  rowBefore: auditLog.rowBefore,
  rowAfter: auditLog.rowAfter,
};

/** What `ROW_COLUMNS` selects: the stored columns plus the exact instant. */
type AuditLogSelection = Readonly<
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
    | "operation"
  >
> & { readonly recordedAtExact: string };

/** Keyset reads on the audit trail with exact stored cursor timestamps. */
export class DrizzleAuditLogReader implements AuditLogReader {
  constructor(private readonly db: DrizzleHandle) {}

  async listRows(
    scope: AuditLogScope,
    filter: AuditLogRowFilter,
    olderThan: AuditLogCursor | null,
    limit: number,
  ): Promise<readonly AuditLogRecord[]> {
    const shownTables = filter.tableNames ?? [];
    const rows = await this.db
      .select(ROW_COLUMNS)
      .from(auditLog)
      .where(
        scope.kind === "application" && shownTables.length > 0
          ? inArray(auditLog.position, this.newestPerShownTable(scope, filter, shownTables, olderThan, limit))
          : and(
              ...scopeConditions(scope, auditLog),
              ...filterConditions(filter, auditLog),
              olderThanAuditCursor(olderThan, auditLog),
            ),
      )
      .orderBy(desc(auditLog.recordedAt), desc(auditLog.position))
      .limit(limit);
    return rows.map(toAuditLogRecord);
  }

  /** Match scope and table through the combined GIN index before paging. */
  private newestPerShownTable(
    scope: AuditLogScope,
    filter: AuditLogRowFilter,
    shownTables: readonly string[],
    olderThan: AuditLogCursor | null,
    limit: number,
  ) {
    const candidate = alias(auditLog, "candidate");
    const newestOfOneTable = this.db
      .select({
        position: candidate.position,
        recordedAt: candidate.recordedAt,
      })
      .from(candidate)
      .where(
        and(
          ...scopeConditions(scope, candidate),
          sql`ARRAY[${candidate.tableName}] @> ARRAY[shown.table_name]`,
          ...filterConditions({ ...filter, tableNames: [] }, candidate),
          olderThanAuditCursor(olderThan, candidate),
        ),
      )
      .orderBy(desc(candidate.recordedAt), desc(candidate.position))
      .limit(limit)
      .as("picked");
    const tables = sql.join(
      shownTables.map((table) => sql`${table}`),
      sql`, `,
    );
    return this.db
      .select({ position: newestOfOneTable.position })
      .from(sql`unnest(ARRAY[${tables}]::text[]) AS shown(table_name)`)
      .crossJoinLateral(newestOfOneTable)
      .orderBy(desc(newestOfOneTable.recordedAt), desc(newestOfOneTable.position))
      .limit(limit);
  }

  async rowsForRequest(requestId: string): Promise<readonly AuditLogRecord[]> {
    const rows = await this.db
      .select(ROW_COLUMNS)
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId))
      .orderBy(asc(auditLog.position));
    return rows.map(toAuditLogRecord);
  }

  async countRecordsForRequest(
    scope: AuditLogScope,
    requestId: string,
    filter: Pick<AuditLogRowFilter, "shownUpdateColumns">,
  ): Promise<number> {
    const [counted] = await this.db
      .select({
        total: sql<number>`count(distinct (${auditLog.tableName}, ${auditLog.rowKey}))::int`,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.requestId, requestId),
          ...scopeConditions(scope, auditLog),
          ...shownUpdateCondition(filter, auditLog),
        ),
      );
    return counted?.total ?? 0;
  }

  async rowAt(position: AuditLogPosition): Promise<AuditLogRecord | null> {
    const [row] = await this.db.select(ROW_COLUMNS).from(auditLog).where(eq(auditLog.position, position)).limit(1);
    return row === undefined ? null : toAuditLogRecord(row);
  }
}

/**
 * The columns the conditions below read, from `audit_log` itself or from an
 * alias of it, so the per-table seek states exactly the same conditions as
 * the plain read.
 */
type AuditLogTable = Readonly<
  Record<
    | "recordedAt"
    | "scopeValues"
    | "position"
    | "userId"
    | "requestId"
    | "actorKind"
    | "tableName"
    | "rowKey"
    | "operation"
    | "changedColumns",
    PgColumn
  >
>;

function scopeConditions(scope: AuditLogScope, table: AuditLogTable): SQL[] {
  if (scope.kind === "platform") return [];
  return Object.keys(scope.values).length === 0
    ? [sql`false`]
    : [sql`${table.scopeValues} @> ${JSON.stringify(scope.values)}::jsonb`];
}

function filterConditions(filter: AuditLogRowFilter, table: AuditLogTable): SQL[] {
  return [
    ...whoAndWhenConditions(filter, table),
    ...whatConditions(filter, table),
    ...shownUpdateCondition(filter, table),
  ];
}

/** The date range and the person. */
function whoAndWhenConditions(filter: AuditLogRowFilter, table: AuditLogTable): SQL[] {
  return [
    ...(filter.from === undefined ? [] : [gte(table.recordedAt, filter.from)]),
    ...(filter.to === undefined ? [] : [lt(table.recordedAt, filter.to)]),
    ...(filter.userId === undefined ? [] : [eq(table.userId, filter.userId)]),
    ...(filter.excludeRequestId === undefined ? [] : [ne(table.requestId, filter.excludeRequestId)]),
  ];
}

/**
 * An update to a named table that changed none of its shown columns is left
 * out. The map travels as one jsonb parameter, so the condition is the same
 * size whatever the number of tables.
 */
function shownUpdateCondition(filter: Pick<AuditLogRowFilter, "shownUpdateColumns">, table: AuditLogTable): SQL[] {
  const shown = filter.shownUpdateColumns;
  if (shown === undefined || Object.keys(shown).length === 0) return [];
  const columnsOfTable = sql`(${JSON.stringify(shown)}::jsonb -> ${table.tableName})`;
  return [
    sql`NOT (
      ${table.operation} = 'update'
      AND ${columnsOfTable} IS NOT NULL
      AND NOT coalesce(
        ${table.changedColumns} && ARRAY(SELECT jsonb_array_elements_text(${columnsOfTable})),
        false
      )
    )`,
  ];
}

/** The kind of actor, the tables and the one record. */
function whatConditions(filter: AuditLogRowFilter, table: AuditLogTable): SQL[] {
  const actorKinds = filter.actorKinds ?? [];
  const tableNames = filter.tableNames ?? [];
  const excluded = filter.excludeTableNames ?? [];
  return [
    ...(actorKinds.length === 0 ? [] : [inArray(table.actorKind, [...actorKinds])]),
    ...(tableNames.length === 0 ? [] : [inArray(table.tableName, [...tableNames])]),
    ...(excluded.length === 0 ? [] : [notInArray(table.tableName, [...excluded])]),
    ...(filter.record === undefined
      ? []
      : [
          eq(table.tableName, filter.record.tableName),
          sql`${table.rowKey} = ${JSON.stringify(filter.record.rowKey)}::jsonb`,
        ]),
  ];
}

/** Strictly after the cursor in `(recorded_at DESC, position DESC)` order. */
function olderThanAuditCursor(olderThan: AuditLogCursor | null, table: AuditLogTable): SQL | undefined {
  if (olderThan === null) return undefined;
  return sql`(${table.recordedAt}, ${table.position}) < (${olderThan.recordedAt}::timestamptz, ${olderThan.position})`;
}

function toAuditLogRecord(row: AuditLogSelection): AuditLogRecord {
  return {
    scopeValues: row.scopeValues,
    position: row.position,
    recordedAt: row.recordedAt,
    actorKind: row.actorKind,
    actorId: row.actorId,
    clientId: row.clientId,
    clientName: row.clientName,
    requestId: row.requestId,
    reason: row.reason,
    userId: row.userId,
    tableName: row.tableName,
    rowKey: row.rowKey,
    operation: toOperation(row.operation),
    changedColumns: row.changedColumns,
    rowBefore: row.rowBefore,
    rowAfter: row.rowAfter,
    cursor: { recordedAt: row.recordedAtExact, position: row.position },
  };
}

/** The table's check constraint admits exactly these three. */
function toOperation(stored: string): AuditLogRecord["operation"] {
  if (stored === "insert" || stored === "update" || stored === "delete") {
    return stored;
  }
  throw new Error(`audit_log.operation holds an unknown value: ${stored}`);
}
