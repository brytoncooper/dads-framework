import { z } from "zod";

/**
 * Who a queued email goes to, as it is stored in `outbound_emails.envelope`.
 *
 * This is the jsonb column's contract, which is why it is a schema rather
 * than a type: a row written by an older build is parsed on the way out, so
 * a shape the kit no longer understands fails loudly at the claim instead of
 * reaching a vendor half-formed. Attachments are deliberately absent —
 * bytes do not belong in jsonb, and only the immediate `sendNow` path takes
 * them.
 */
const emailAddressSchema = z.object({
  address: z.email(),
  /** Display name shown beside the address; absent renders the address alone. */
  name: z.string().min(1).optional(),
});

/** The ASCII labels vendors accept for delivery reporting. */
const EMAIL_TAG_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

export const emailEnvelopeSchema = z.object({
  to: z.array(emailAddressSchema).min(1),
  cc: z.array(emailAddressSchema).optional(),
  bcc: z.array(emailAddressSchema).optional(),
  replyTo: emailAddressSchema.optional(),
  headers: z.record(z.string(), z.string()).optional(),
  tags: z.array(z.string().regex(EMAIL_TAG_PATTERN)).optional(),
});

export type EmailEnvelope = z.infer<typeof emailEnvelopeSchema>;
