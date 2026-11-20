import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  AuditRowImage,
  AuditRowKey,
  AuditScopeValues,
} from "../audit-row-json.js";
import type { AuditLogPosition } from "../audit-log-position.ids.js";
import { xid8 } from "@dads-framework/postgres";

/**
 * Every row change in the database, state-grained and actor-stamped
 * by the database. Written only by the `audit_record` trigger; nothing in the
 * application inserts here, and a trigger refuses updates and deletes.
 *
 * `requestId` is a plain string rather than a branded id: it joins to
 * `request_log` and is minted per request at the seam, not by a domain that
 * could own an identity type for it.
 */

export const auditLog = pgTable(
  "audit_log",
  {
    position: bigint("position", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity()
      .notNull()
      .$type<AuditLogPosition>(),
    transactionId: xid8("transaction_id")
      .default(sql`pg_current_xact_id()`)
      .notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    requestId: text("request_id").notNull(),
    reason: text("reason"),
    ownerPartitionId: uuid("owner_partition_id"),
    tableName: text("table_name").notNull(),
    scopeValues: jsonb("scope_values").$type<AuditScopeValues>(),
    rowKey: jsonb("row_key").notNull().$type<AuditRowKey>(),
    operation: text("operation").notNull(),
    changedColumns: text("changed_columns").array(),
    rowBefore: jsonb("row_before").$type<AuditRowImage>(),
    rowAfter: jsonb("row_after").$type<AuditRowImage>(),
    userId: text("user_id"),
    clientId: text("client_id"),
    clientName: text("client_name"),
  },
  (table) => [
    index("audit_log_actor_position_idx").on(
      table.actorKind,
      table.actorId,
      table.position,
    ),
    index("audit_log_scope_table_idx").using(
      "gin",
      sql`${table.scopeValues} jsonb_path_ops`,
      sql`(ARRAY[${table.tableName}])`,
    ),
    index("audit_log_partition_position_idx").on(
      table.ownerPartitionId,
      table.position,
    ),
    index("audit_log_request_idx").on(table.requestId),
    index("audit_log_row_time_idx").on(
      table.tableName,
      table.rowKey,
      sql`${table.recordedAt} DESC`,
      sql`${table.position} DESC`,
    ),
    index("audit_log_table_position_idx").on(table.tableName, table.position),
    index("audit_log_time_idx").on(
      sql`${table.recordedAt} DESC`,
      sql`${table.position} DESC`,
    ),
    index("audit_log_user_time_idx")
      .on(
        table.userId,
        sql`${table.recordedAt} DESC`,
        sql`${table.position} DESC`,
      )
      .where(sql`${table.userId} IS NOT NULL`),
    check(
      "audit_log_operation_check",
      sql`${table.operation} = ANY (ARRAY['insert'::text, 'update'::text, 'delete'::text])`,
    ),
  ],
);
