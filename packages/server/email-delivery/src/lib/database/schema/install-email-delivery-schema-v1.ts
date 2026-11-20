import type { MigrationBuilder } from "node-pg-migrate";

import { installQueuedEmailAttachmentsV1 } from "./install-queued-email-attachments-v1.js";

/** Fresh-product schema snapshot. Existing products apply the additive migrations. */
export function installEmailDeliverySchemaV1(pgm: MigrationBuilder): void {
  pgm.createTable("outbound_emails", {
    id: {
      type: "uuid",
      primaryKey: true,
      notNull: true,
      default: pgm.func("gen_random_uuid()"),
    },
    template_name: { type: "text", notNull: true },
    props: { type: "jsonb", notNull: true },
    envelope: { type: "jsonb", notNull: true },
    send_at: { type: "timestamptz", notNull: true },
    status: { type: "text", notNull: true },
    attempts: { type: "integer", notNull: true, default: 0 },
    next_attempt_at: { type: "timestamptz" },
    claimed_at: { type: "timestamptz" },
    last_error: { type: "text" },
    provider_message_id: { type: "text" },
    dedupe_key: { type: "text" },
    attachment_count: { type: "integer", notNull: true, default: 0 },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    sent_at: { type: "timestamptz" },
  });
  pgm.createIndex("outbound_emails", ["status", "send_at"], {
    name: "outbound_emails_status_send_at_idx",
  });
  pgm.createIndex("outbound_emails", ["dedupe_key"], {
    name: "outbound_emails_dedupe_key_idx",
    unique: true,
    where: "dedupe_key IS NOT NULL",
  });

  pgm.addConstraint("outbound_emails", "outbound_emails_status_check", {
    check:
      "status = ANY (ARRAY['queued'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'cancelled'::text])",
  });

  pgm.sql(
    `CREATE TRIGGER audit_record AFTER INSERT OR UPDATE OR DELETE ON "outbound_emails" FOR EACH ROW EXECUTE FUNCTION audit_record('id', '')`,
  );
  installQueuedEmailAttachmentsV1(pgm);
}
