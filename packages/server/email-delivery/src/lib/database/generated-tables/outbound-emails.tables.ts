// GENERATED - DO NOT EDIT. Author a migration, then run npm run db:schema:generate.
// Schema fingerprint ab0a0749a9de3a22: columns, constraints, indexes, triggers.

import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { EmailEnvelope } from "../../email-envelope.js";
import type { OutboundEmailProps } from "../outbound-email-props.js";
import type { OutboundEmailId } from "../../outbound-email-status.js";
import { OUTBOUND_EMAIL_STATUS_VALUES } from "../../outbound-email-status.js";

/**
 * One outbound email: what to render, who it goes to, when it is due, and
 * every attempt made on it. The row is the source of truth and the retry
 * engine — the jobs only decide when to look at it.
 */

export const outboundEmail = pgTable(
  "outbound_emails",
  {
    id: uuid("id")
      .primaryKey()
      .defaultRandom()
      .notNull()
      .$type<OutboundEmailId>(),
    templateName: text("template_name").notNull(),
    props: jsonb("props").notNull().$type<OutboundEmailProps>(),
    envelope: jsonb("envelope").notNull().$type<EmailEnvelope>(),
    sendAt: timestamp("send_at", { withTimezone: true }).notNull(),
    status: text("status", { enum: OUTBOUND_EMAIL_STATUS_VALUES }).notNull(),
    attempts: integer("attempts").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    lastError: text("last_error"),
    providerMessageId: text("provider_message_id"),
    dedupeKey: text("dedupe_key"),
    attachmentCount: integer("attachment_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("outbound_emails_dedupe_key_idx")
      .on(table.dedupeKey)
      .where(sql`${table.dedupeKey} IS NOT NULL`),
    index("outbound_emails_status_send_at_idx").on(table.status, table.sendAt),
    check(
      "outbound_emails_status_check",
      sql`${table.status} = ANY (ARRAY['queued'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'cancelled'::text])`,
    ),
  ],
);
