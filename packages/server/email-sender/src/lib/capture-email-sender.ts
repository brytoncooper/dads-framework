import type { CapturedMailbox } from "./captured-mailbox.js";
import type {
  EmailMessage,
  EmailSender,
  EmailSendReceipt,
} from "@dads-framework/email-sender-core";
import {
  formatEmailAddress,
  formatEmailAddresses,
} from "./logic/format-email-address.js";

/**
 * Development-page driver (`MAIL_DRIVER=capture`): keeps the WHOLE email —
 * recipient, subject, body, and any activation or verification link — in a
 * {@link CapturedMailbox} so a developer can read what was sent at
 * `GET /api/mail` without a mail vendor. Captures are lost on restart.
 *
 * It logs nothing: the mailbox is the only place the message lands, and bodies
 * carry one-time tokens. NEVER run this outside a developer's own machine.
 * `log` (the default, {@link LogEmailSender}) is the CI and shared-environment
 * driver: it records that a send happened and withholds the body.
 *
 * Attachments are held by name and size only. The page shows what was
 * attached; the bytes stop at this boundary.
 */
export class CaptureEmailSender implements EmailSender {
  constructor(
    private readonly mailbox: CapturedMailbox,
    private readonly from: string,
  ) {}

  send(message: EmailMessage): Promise<EmailSendReceipt> {
    const id = this.mailbox.record({
      from:
        message.from === undefined
          ? this.from
          : formatEmailAddress(message.from),
      to: formatEmailAddresses(message.to),
      ...(message.cc === undefined
        ? {}
        : { cc: formatEmailAddresses(message.cc) }),
      ...(message.bcc === undefined
        ? {}
        : { bcc: formatEmailAddresses(message.bcc) }),
      ...(message.replyTo === undefined
        ? {}
        : { replyTo: formatEmailAddress(message.replyTo) }),
      subject: message.subject,
      text: message.text,
      ...(message.html === undefined ? {} : { html: message.html }),
      ...(message.attachments === undefined
        ? {}
        : {
            attachments: message.attachments.map((attachment) => ({
              filename: attachment.filename,
              contentType: attachment.contentType,
              sizeBytes: attachment.content.byteLength,
            })),
          }),
      ...(message.tags === undefined ? {} : { tags: [...message.tags] }),
      ...(message.headers === undefined
        ? {}
        : { headers: { ...message.headers } }),
    });
    return Promise.resolve({ providerMessageId: id });
  }
}
