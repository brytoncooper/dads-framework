import type { MigrationBuilder } from "node-pg-migrate";

/** Versioned schema snapshot: migrations retain this function's definition. */
export function installQueuedEmailAttachmentsV1(pgm: MigrationBuilder): void {
  pgm.createTable("outbound_email_documents", {
    outbound_email_id: {
      type: "uuid",
      primaryKey: true,
      notNull: true,
      references: "outbound_emails(id)",
      onDelete: "RESTRICT",
    },
    attachments: { type: "jsonb", notNull: true },
    failure_policy: { type: "text", notNull: true },
  });
  pgm.addConstraint(
    "outbound_email_documents",
    "outbound_email_documents_policy_check",
    {
      check: "failure_policy IN ('retry', 'manual-review')",
    },
  );
  pgm.addConstraint(
    "outbound_email_documents",
    "outbound_email_documents_attachments_check",
    {
      check: "jsonb_typeof(attachments) = 'array'",
    },
  );
  pgm.sql(
    `CREATE TRIGGER audit_record AFTER INSERT OR UPDATE OR DELETE ON outbound_email_documents FOR EACH ROW EXECUTE FUNCTION audit_record('outbound_email_id', '')`,
  );
  pgm.sql(`
    CREATE FUNCTION outbound_email_document_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'queued email document references are immutable' USING ERRCODE = 'insufficient_privilege';
    END;
    $$;
    CREATE TRIGGER outbound_email_document_immutable BEFORE UPDATE OR DELETE ON outbound_email_documents
      FOR EACH ROW EXECUTE FUNCTION outbound_email_document_immutable();
  `);
}
