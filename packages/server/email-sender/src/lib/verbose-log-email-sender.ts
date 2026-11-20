import type {
  EmailMessage,
  EmailSender,
  EmailSendReceipt,
} from "../core/index.js";
import {
  formatEmailAddress,
  formatEmailAddresses,
} from "./logic/format-email-address.js";

/**
 * Developer-readability driver (`MAIL_DRIVER=log-verbose`): renders the WHOLE
 * email — recipient, subject, body, and any activation or verification link —
 * into the structured logger so a developer can read what was sent without a
 * mail vendor.
 *
 * NEVER run this outside a developer's own machine. Bodies carry one-time
 * invitation and verification tokens, so these logs are credential material.
 * `log` (the default, {@link LogEmailSender}) is the CI and shared-environment
 * driver: it records that a send happened and withholds the body.
 *
 * Attachments are rendered by name, type and size. Even here the bytes stay
 * out: a base64 blob in a log line is unreadable to the developer this driver
 * exists for, and it is the one part of a message a log cannot hold usefully.
 */
export class VerboseLogEmailSender implements EmailSender {
  constructor(
    private readonly log: { info(obj: object, msg?: string): void },
    private readonly from: string,
  ) {}

  send(message: EmailMessage): Promise<EmailSendReceipt> {
    this.log.info(
      {
        event: "email.rendered",
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
        ...(message.headers === undefined
          ? {}
          : { headers: { ...message.headers } }),
        ...(message.tags === undefined ? {} : { tags: [...message.tags] }),
      },
      "email not sent (MAIL_DRIVER=log-verbose) — rendered above",
    );
    return Promise.resolve({ providerMessageId: null });
  }
}
