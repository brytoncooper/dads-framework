import { deterministicUuid } from "@dads-framework/postgres/testing/deterministic-uuid";

import type { outboundEmailDocument } from "../database/generated-tables/outbound-email-documents.tables.js";
import type { outboundEmail } from "../database/generated-tables/outbound-emails.tables.js";
import { type OutboundEmailId, outboundEmailIdSchema } from "../outbound-email-status.js";

type OutboundEmailInsert = typeof outboundEmail.$inferInsert;

const FIXED_DATE = new Date("2026-01-01T00:00:00.000Z");

let outboundEmailCounter = 0;

/** A deterministic branded id, parsed rather than cast. */
export function outboundEmailId(sequence: number): OutboundEmailId {
  return outboundEmailIdSchema.parse(deterministicUuid("outbound-email", sequence));
}

/**
 * Every field valid by default, deterministic ids, overrides spread last
 * (docs/testing/seeders.md). Outbound-email rows carry no ownership tuples —
 * they are platform-internal, readable only through operator-gated actions.
 */
export function makeOutboundEmail(overrides: Partial<OutboundEmailInsert> = {}): OutboundEmailInsert {
  outboundEmailCounter += 1;
  return {
    id: outboundEmailId(outboundEmailCounter),
    templateName: "email-templates.component-showcase",
    props: { recipientName: "Dana Reyes" },
    envelope: { to: [{ address: "dana@example.test" }] },
    sendAt: FIXED_DATE,
    status: "queued",
    attempts: 0,
    nextAttemptAt: null,
    claimedAt: null,
    lastError: null,
    providerMessageId: null,
    dedupeKey: null,
    attachmentCount: 0,
    createdAt: FIXED_DATE,
    sentAt: null,
    ...overrides,
  };
}

export function makeOutboundEmailDocument(
  overrides: Partial<typeof outboundEmailDocument.$inferInsert> = {},
): typeof outboundEmailDocument.$inferInsert {
  return {
    outboundEmailId: outboundEmailId(1),
    attachments: [],
    failurePolicy: "manual-review",
    ...overrides,
  };
}
