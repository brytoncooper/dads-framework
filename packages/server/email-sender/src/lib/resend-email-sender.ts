import { Resend, type CreateEmailOptions } from "resend";
import type {
  EmailMessage,
  EmailSender,
  EmailSendReceipt,
} from "@dads-framework/email-sender-core";
import { formatEmailAddress } from "./logic/format-email-address.js";

/**
 * The Resend driver — active when MAIL_DRIVER=resend and RESEND_API_KEY is
 * set. A future SES/Postmark driver is one small class plus one factory
 * branch.
 */
export class ResendEmailSender implements EmailSender {
  private readonly resend: Resend;

  constructor(
    apiKey: string,
    private readonly from: string,
  ) {
    this.resend = new Resend(apiKey);
  }

  async send(message: EmailMessage): Promise<EmailSendReceipt> {
    const { data, error } = await this.resend.emails.send(
      toResendPayload(message, this.from),
    );
    if (error) {
      throw new Error(`Resend rejected the email: ${error.message}`);
    }
    return { providerMessageId: data.id };
  }
}

/**
 * The message envelope in Resend's vocabulary. Resend models a tag as a
 * name/value pair while the shared envelope carries plain labels, so each tag is sent as
 * its own name and value.
 */
function toResendPayload(
  message: EmailMessage,
  defaultFrom: string,
): CreateEmailOptions {
  return {
    from:
      message.from === undefined
        ? defaultFrom
        : formatEmailAddress(message.from),
    to: message.to.map(formatEmailAddress),
    subject: message.subject,
    text: message.text,
    ...(message.html === undefined ? {} : { html: message.html }),
    ...(message.cc === undefined
      ? {}
      : { cc: message.cc.map(formatEmailAddress) }),
    ...(message.bcc === undefined
      ? {}
      : { bcc: message.bcc.map(formatEmailAddress) }),
    ...(message.replyTo === undefined
      ? {}
      : { replyTo: formatEmailAddress(message.replyTo) }),
    ...(message.headers === undefined
      ? {}
      : { headers: { ...message.headers } }),
    ...(message.tags === undefined
      ? {}
      : { tags: message.tags.map((tag) => ({ name: tag, value: tag })) }),
    ...(message.attachments === undefined
      ? {}
      : {
          attachments: message.attachments.map((attachment) => ({
            filename: attachment.filename,
            contentType: attachment.contentType,
            content: Buffer.from(attachment.content),
          })),
        }),
  };
}
