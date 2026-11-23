/**
 * Outbound email seam. Composition injects one EmailSender; callers only
 * call send(). Swapping Resend for another vendor is a factory/env change.
 */

/** One addressee. `name` is a display name only; `address` is the mailbox. */
export type EmailAddress = {
  readonly address: string;
  /** Display name shown beside the address; absent renders the address alone. */
  readonly name?: string;
};

/** One attached file, held as bytes until a driver hands it to its vendor. */
export type EmailAttachment = {
  readonly filename: string;
  /** MIME type the recipient's client should open the bytes with. */
  readonly contentType: string;
  readonly content: Uint8Array;
};

/** What the vendor said about one accepted message. */
export type EmailSendReceipt = {
  /** The vendor's id for the message; `null` when the driver never sends. */
  readonly providerMessageId: string | null;
};

export type EmailMessage = {
  /** At least one addressee; a driver receiving an empty list sends nothing. */
  readonly to: readonly EmailAddress[];
  readonly cc?: readonly EmailAddress[];
  readonly bcc?: readonly EmailAddress[];
  readonly replyTo?: EmailAddress;
  /** Overrides the sender address the driver was configured with. */
  readonly from?: EmailAddress;
  readonly subject: string;
  readonly text: string;
  /** optional HTML body; text remains the fallback */
  readonly html?: string;
  readonly attachments?: readonly EmailAttachment[];
  /** Extra headers, passed through verbatim. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Vendor-side labels for grouping delivery reporting. Each tag is ASCII
   * `[A-Za-z0-9_-]{1,256}`; anything else is a vendor rejection, not a retry.
   */
  readonly tags?: readonly string[];
};

export abstract class EmailSender {
  abstract send(message: EmailMessage): Promise<EmailSendReceipt>;
}
