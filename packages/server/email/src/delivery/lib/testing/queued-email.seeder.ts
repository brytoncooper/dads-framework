import type { DrizzleHandle } from "@dads-framework/postgres";

import { outboundEmailDocument } from "../database/generated-tables/outbound-email-documents.tables.js";
import { outboundEmail } from "../database/generated-tables/outbound-emails.tables.js";
import { outboundEmailIdSchema } from "../outbound-email-status.js";
import { makeOutboundEmail, makeOutboundEmailDocument } from "./outbound-email.factory.js";

type QueuedEmailOverrides = {
  email?: Partial<Omit<typeof outboundEmail.$inferInsert, "status" | "attachmentCount">>;
  document?: Partial<Omit<typeof outboundEmailDocument.$inferInsert, "outboundEmailId">>;
};

export async function seedQueuedEmailWithDocuments(db: DrizzleHandle, overrides: QueuedEmailOverrides = {}) {
  const email = makeOutboundEmail(overrides.email);
  const document = makeOutboundEmailDocument({
    ...overrides.document,
    outboundEmailId: outboundEmailIdSchema.parse(email.id),
  });
  const queuedEmail = {
    ...email,
    attachmentCount: document.attachments.length,
  };

  await db.transaction(async (tx) => {
    await tx.insert(outboundEmail).values([queuedEmail]);
    await tx.insert(outboundEmailDocument).values([document]);
  });

  return { email: queuedEmail, document };
}
