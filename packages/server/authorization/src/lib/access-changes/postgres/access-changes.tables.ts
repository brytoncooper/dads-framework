// GENERATED - DO NOT EDIT. Author a migration, then run npm run db:schema:generate.
// Schema fingerprint 839b9f107208b809: columns, constraints, indexes, triggers.

import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { AccessChangeId } from "../access-change.ids.js";
import { OUTBOX_OPERATION_VALUES, OUTBOX_STATUS_VALUES } from "../enqueue.js";

export type AccessResourceId = string;
export type AccessSubjectId = string;
export type AuthorityPartitionId = string;

export const authorizationOutbox = pgTable(
  "authorization_outbox",
  {
    id: uuid("id")
      .primaryKey()
      .defaultRandom()
      .notNull()
      .$type<AccessChangeId>(),
    idempotencyKey: text("idempotency_key").notNull(),
    operation: text("operation", { enum: OUTBOX_OPERATION_VALUES }).notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull().$type<AccessResourceId>(),
    relation: text("relation").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull().$type<AccessSubjectId>(),
    subjectRelation: text("subject_relation"),
    ownerPartitionId: uuid("owner_partition_id").$type<AuthorityPartitionId>(),
    status: text("status", { enum: OUTBOX_STATUS_VALUES }).notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull(),
    projectedAt: timestamp("projected_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededByIdempotencyKey: text("superseded_by_idempotency_key"),
  },
  (table) => [
    uniqueIndex("authorization_outbox_idempotency_uidx").on(
      table.idempotencyKey,
    ),
    index("authorization_outbox_partition_idx").on(table.ownerPartitionId),
    index("authorization_outbox_status_enqueued_idx").on(
      table.status,
      table.enqueuedAt,
    ),
    check(
      "authorization_outbox_supersession_check",
      sql`((${table.status} = 'SUPERSEDED'::text) AND (${table.supersededAt} IS NOT NULL) AND (${table.supersededByIdempotencyKey} IS NOT NULL) AND (${table.lastError} IS NULL)) OR ((${table.status} <> 'SUPERSEDED'::text) AND (${table.supersededAt} IS NULL) AND (${table.supersededByIdempotencyKey} IS NULL))`,
    ),
  ],
);
