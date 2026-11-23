import { z } from "zod";

export const queuedEmailAttachmentSchema = z.strictObject({
  objectKey: z.string().min(1).max(1024),
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(255),
  byteSize: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const queuedEmailAttachmentsSchema = z
  .array(queuedEmailAttachmentSchema)
  .max(20);
export type QueuedEmailAttachment = z.infer<typeof queuedEmailAttachmentSchema>;
export type EmailFailurePolicy = "retry" | "manual-review";

/** Loads and verifies the exact bytes identified by a durable, immutable reference. */
export type LoadEmailAttachment = (
  reference: QueuedEmailAttachment,
) => Promise<Uint8Array>;

export const SEND_OUTCOME_UNKNOWN_ERROR = "SEND_OUTCOME_UNKNOWN";
