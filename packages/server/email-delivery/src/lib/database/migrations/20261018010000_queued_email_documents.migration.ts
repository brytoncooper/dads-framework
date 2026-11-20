import type { MigrationBuilder } from "node-pg-migrate";

import { installQueuedEmailAttachmentsV1 } from "../schema/install-queued-email-attachments-v1.js";

export function up(pgm: MigrationBuilder): void {
  installQueuedEmailAttachmentsV1(pgm);
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable("outbound_email_documents");
  pgm.sql("DROP FUNCTION outbound_email_document_immutable()");
}
