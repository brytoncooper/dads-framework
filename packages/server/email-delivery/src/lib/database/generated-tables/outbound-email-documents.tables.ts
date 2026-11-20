// GENERATED - DO NOT EDIT. Author a migration, then run npm run db:schema:generate.
// Schema fingerprint 04d64cdfe2a07969: columns, constraints, indexes, triggers.

import { check, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { OutboundEmailId } from "../../outbound-email-status.js";
import type {
  EmailFailurePolicy,
  QueuedEmailAttachment,
} from "../../queued-email-attachment.js";
import { outboundEmail } from "./outbound-emails.tables.js";

export const outboundEmailDocument = pgTable(
  "outbound_email_documents",
  {
    outboundEmailId: uuid("outbound_email_id")
      .primaryKey()
      .notNull()
      .references(() => outboundEmail.id, { onDelete: "restrict" })
      .$type<OutboundEmailId>(),
    attachments: jsonb("attachments")
      .notNull()
      .$type<readonly QueuedEmailAttachment[]>(),
    failurePolicy: text("failure_policy").notNull().$type<EmailFailurePolicy>(),
  },
  (table) => [
    check(
      "outbound_email_documents_attachments_check",
      sql`jsonb_typeof(${table.attachments}) = 'array'::text`,
    ),
    check(
      "outbound_email_documents_policy_check",
      sql`${table.failurePolicy} = ANY (ARRAY['retry'::text, 'manual-review'::text])`,
    ),
  ],
);
