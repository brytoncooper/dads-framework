// GENERATED - DO NOT EDIT. Author a migration, then run npm run db:schema:generate.
// Schema fingerprint 57503aacd77b4972: columns, constraints, indexes, triggers.

import {
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
  ClientContext,
  ClientDiagnosticBreadcrumb,
  ClientDiagnosticFrame,
} from "@dads-framework/contract";
import type { ClientDiagnosticEventId } from "../../client-diagnostics/client-diagnostic-event.ids.js";

/**
 * Faults a client reported that never became a request: a render that threw,
 * a rejected promise, a chunk that would not load, a response that did not
 * match the contract the client compiled against. `request_log` is
 * structurally blind to all of them.
 *
 * Joins back through `requestId` — one string off a user's screenshot reaches
 * the browser's fault, the request's environment, and the rows it changed.
 *
 * No `audit_record` trigger is attached — see `AUDIT_TRIGGER_ALLOWLIST`.
 * Rows here are pruned on their own schedule.
 */

export const clientDiagnosticEvents = pgTable(
  "client_diagnostic_events",
  {
    id: uuid("id").primaryKey().notNull().$type<ClientDiagnosticEventId>(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    fingerprint: text("fingerprint").notNull(),
    kind: text("kind").notNull(),
    severity: text("severity").notNull(),
    name: text("name").notNull(),
    message: text("message").notNull(),
    frames: jsonb("frames").$type<readonly ClientDiagnosticFrame[]>().notNull(),
    breadcrumbs: jsonb("breadcrumbs")
      .$type<readonly ClientDiagnosticBreadcrumb[]>()
      .notNull(),
    release: text("release").notNull(),
    client: text("client").notNull(),
    requestId: text("request_id"),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    context: jsonb("context").$type<ClientContext>(),
  },
  (table) => [
    index("client_diagnostic_events_fingerprint_recorded_at_idx").on(
      table.fingerprint,
      table.recordedAt,
    ),
    index("client_diagnostic_events_recorded_at_idx").on(table.recordedAt),
    index("client_diagnostic_events_release_recorded_at_idx").on(
      table.release,
      table.recordedAt,
    ),
    index("client_diagnostic_events_request_idx").on(table.requestId),
    check(
      "client_diagnostic_events_severity_check",
      sql`${table.severity} = ANY (ARRAY['error'::text, 'warning'::text, 'info'::text])`,
    ),
  ],
);
