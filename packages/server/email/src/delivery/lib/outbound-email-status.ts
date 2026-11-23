import { z } from "zod";

/**
 * Where one outbound email is in its life. The set is closed by a check
 * constraint on `outbound_emails.status`, so a value invented in TypeScript
 * is rejected by the database rather than stored.
 *
 * - `queued` — due at `send_at`, waiting for a delivery job or the sweep.
 * - `sending` — claimed by one attempt. A row is claimed exactly once per
 *   attempt, which is why a crash leaves it here rather than resending.
 * - `sent` — the vendor accepted it; `provider_message_id` is the handle.
 * - `failed` — out of attempts, or a failure no retry can fix. An operator
 *   action re-queues it; nothing resends on its own.
 * - `cancelled` — withdrawn before it was sent.
 */
export const OUTBOUND_EMAIL_STATUS_VALUES = ["queued", "sending", "sent", "failed", "cancelled"] as const;

export type OutboundEmailStatus = (typeof OUTBOUND_EMAIL_STATUS_VALUES)[number];

/** A row's id, branded so it cannot be confused with any other uuid. */
export const outboundEmailIdSchema = z.uuid().brand<"OutboundEmailId">();

export type OutboundEmailId = z.infer<typeof outboundEmailIdSchema>;
