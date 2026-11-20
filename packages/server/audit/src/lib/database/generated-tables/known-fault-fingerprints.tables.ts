// GENERATED - DO NOT EDIT. Author a migration, then run npm run db:schema:generate.
// Schema fingerprint 4389acf7541bd90a: columns, constraints, indexes, triggers.

import {
  check,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Fault types that have already been alerted on. Never pruned: it is what lets
 * the sweep say "new" truthfully after the fault tables it watches have aged
 * their rows out.
 *
 * `request_log` keeps 90 days and client diagnostics keep 30, so a fault that
 * goes quiet and returns looks brand new to any query over them. Here it does
 * not. The row is written when the fingerprint is alerted, which also makes
 * the sweep idempotent whatever lookback window it runs with.
 *
 * Server and client fingerprints are computed by different code over different
 * inputs, so the same eight characters can mean two unrelated faults; the
 * origin is part of the identity, not a label on it.
 *
 * No `audit_record` trigger is attached — see `AUDIT_TRIGGER_ALLOWLIST`. This
 * is the alerting system's own bookkeeping, not business history.
 */

export const knownFaultFingerprints = pgTable(
  "known_fault_fingerprints",
  {
    origin: text("origin").notNull(),
    fingerprint: text("fingerprint").notNull(),
    firstAlertedAt: timestamp("first_alerted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.origin, table.fingerprint] }),
    check(
      "known_fault_fingerprints_origin_check",
      sql`${table.origin} = ANY (ARRAY['server'::text, 'client'::text])`,
    ),
  ],
);
