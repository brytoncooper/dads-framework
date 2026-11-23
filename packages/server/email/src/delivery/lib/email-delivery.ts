import type { EmailAttachment } from "../../core/index.js";

import type { OutboundEmailTx } from "./database/outbound-email-store.js";
import type { EmailEnvelope } from "./email-envelope.js";
import type { EmailTemplate } from "./email-template-port.js";
import type { OutboundEmailId } from "./outbound-email-status.js";
import type {
  EmailFailurePolicy,
  QueuedEmailAttachment,
} from "./queued-email-attachment.js";

/** The structured logger this kit writes its delivery events to. */
export type EmailDeliveryLog = {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
};

export type EnqueueEmailOptions = {
  readonly attachments?: readonly QueuedEmailAttachment[];
  /** Document issuance uses manual review when transport acceptance is uncertain. */
  readonly failurePolicy?: EmailFailurePolicy;
  /** When the send becomes due. Omitted means now. */
  readonly sendAt?: Date;
  /** Makes the enqueue idempotent; derive it from the cause, not the message. */
  readonly dedupeKey?: string;
  /**
   * Writes the row inside the caller's transaction. Dispatch is then the
   * caller's to do after the commit — a job that starts before the
   * transaction commits would find nothing.
   */
  readonly tx?: OutboundEmailTx;
};

export type EnqueuedEmail = {
  readonly id: OutboundEmailId;
  /** The row already existed under this dedupe key; nothing new was written. */
  readonly deduplicated: boolean;
  /** A delivery job was asked for. False when the caller owns the dispatch. */
  readonly dispatched: boolean;
};

export type SendNowOptions = {
  /** Only the immediate path takes attachments — bytes never enter the row. */
  readonly attachments?: readonly EmailAttachment[];
};

export type SentEmail = {
  readonly id: OutboundEmailId;
  readonly providerMessageId: string | null;
};

/**
 * How the rest of the system sends email. Abstract class = the type callers
 * hold and the injection token composition binds, the way `Clock` and
 * `EmailSender` work.
 *
 * Two paths, deliberately different:
 *
 * - `enqueue` writes a row and lets a job send it, so the request does not
 *   wait on a vendor and a crash loses nothing.
 * - `sendNow` sends inside the request and throws when the vendor refuses.
 *   Identity's three auth emails use it on purpose: the invitee's
 *   inbox is the proof of address, so an operator has to learn immediately
 *   that a send went nowhere.
 */
export abstract class EmailDelivery {
  /** Records the send and, unless the caller owns the transaction, starts it. */
  abstract enqueue(
    template: EmailTemplate,
    props: Record<string, unknown>,
    envelope: EmailEnvelope,
    options?: EnqueueEmailOptions,
  ): Promise<EnqueuedEmail>;

  /**
   * Asks for a delivery job per id. Never throws: a queue that cannot accept
   * work is a warning, because the sweep picks the row up a minute later.
   */
  abstract dispatch(ids: readonly OutboundEmailId[]): Promise<void>;

  /** Renders and sends in-band, recording the result either way, then rethrows. */
  abstract sendNow(
    template: EmailTemplate,
    props: Record<string, unknown>,
    envelope: EmailEnvelope,
    options?: SendNowOptions,
  ): Promise<SentEmail>;
}
