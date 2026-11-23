import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { ClientContext } from "@dads-framework/core/contract";
import type { RequestId } from "@dads-framework/http";
import { inet } from "@dads-framework/postgres";

/** Client hint headers and their captured string values. */
type RequestClientHints = Readonly<Record<string, string>>;

/**
 * One row per mutating request or denial, written off the request path
 * (ADR-0112 slice B). Joins to `audit_log` by `requestId`: this table is a
 * request's environment (IP, user agent, route, decision), `audit_log` is a
 * row's history.
 *
 * No `audit_record` trigger is attached — see `AUDIT_TRIGGER_ALLOWLIST`.
 * Rows here are pruned on a schedule; `audit_log` is never pruned.
 */

export const requestLog = pgTable(
  "request_log",
  {
    requestId: text("request_id").primaryKey().notNull().$type<RequestId>(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    method: text("method").notNull(),
    routeId: text("route_id"),
    path: text("path").notNull(),
    status: integer("status").notNull(),
    durationMs: integer("duration_ms").notNull(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    authMethod: text("auth_method"),
    accessKind: text("access_kind"),
    permission: text("permission"),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    decision: text("decision").notNull(),
    errorCode: text("error_code"),
    ip: inet("ip"),
    forwardedFor: text("forwarded_for"),
    userAgent: text("user_agent"),
    clientHints: jsonb("client_hints").$type<RequestClientHints>(),
    acceptLanguage: text("accept_language"),
    clientContext: jsonb("client_context").$type<ClientContext>(),
    apiRelease: text("api_release"),
    dbQueryCount: integer("db_query_count"),
    dbMs: integer("db_ms"),
    authzCheckCount: integer("authz_check_count"),
    authzMs: integer("authz_ms"),
    instanceId: text("instance_id"),
    exceptionType: text("exception_type"),
    exceptionFingerprint: text("exception_fingerprint"),
    traceId: text("trace_id"),
    imported: boolean("imported").notNull().default(false),
    authzCachedReadCount: integer("authz_cached_read_count"),
    authzFullyConsistentReadCount: integer("authz_fully_consistent_read_count"),
    authzLargestLookupCount: integer("authz_largest_lookup_count"),
  },
  (table) => [
    index("request_log_actor_recorded_at_idx").on(
      table.actorKind,
      table.actorId,
      table.recordedAt,
    ),
    index("request_log_exception_recorded_at_idx").on(
      table.exceptionFingerprint,
      table.recordedAt,
    ),
    index("request_log_recorded_at_idx").on(table.recordedAt),
    index("request_log_route_recorded_at_idx").on(
      table.routeId,
      table.recordedAt,
    ),
    index("request_log_status_recorded_at_idx").on(
      table.status,
      table.recordedAt,
    ),
    check(
      "request_log_decision_check",
      sql`${table.decision} = ANY (ARRAY['allow'::text, 'denied'::text, 'not-found'::text, 'unauthenticated'::text, 'error'::text])`,
    ),
  ],
);
