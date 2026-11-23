import type { MigrationBuilder } from "node-pg-migrate";

/**
 * The outbound-email outbox. A row is the request to send, the schedule, and
 * the attempt history in one place, so the retry engine is this table rather
 * than a queue feature — see the kit's INVARIANTS.md.
 *
 * `props` and `envelope` are jsonb because what a template needs and who a
 * message goes to are both open shapes the database has no reason to know;
 * the kit parses them with Zod on the way out. Attachment BYTES never land
 * here — `attachment_count` records that an immediate send carried some.
 */
export function up(pgm: MigrationBuilder): void {
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

  // The sweep's one query: what is queued and due. Ordered status first
  // because that is the equality, `send_at` second because that is the range.
  pgm.createIndex("outbound_emails", ["status", "send_at"], {
    name: "outbound_emails_status_send_at_idx",
  });

  // Partial, so the many rows with no dedupe key do not collide with each
  // other — in SQL every NULL is distinct, but the index stays smaller too.
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
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable("outbound_emails");
}
