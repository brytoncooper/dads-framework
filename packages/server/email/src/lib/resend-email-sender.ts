import type * as ResendModule from "resend";
import type { CreateEmailOptions, Resend } from "resend";
import type {
  EmailMessage,
  EmailSender,
  EmailSendReceipt,
} from "../core/index.js";
import { loadOptionalPeer } from "../optional-peer.js";
import { formatEmailAddress } from "./logic/format-email-address.js";

/**
 * The Resend driver — active when MAIL_DRIVER=resend and RESEND_API_KEY is
 * set. A future SES/Postmark driver is one small class plus one factory
 * branch.
 */
export class ResendEmailSender implements EmailSender {
  private resend: Promise<Resend> | undefined;

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<EmailSendReceipt> {
    this.resend ??= createResendClient(this.apiKey).catch((error: unknown) => {
      this.resend = undefined;
      throw error;
    });
    const resend = await this.resend;
    const { data, error } = await resend.emails.send(
      toResendPayload(message, this.from),
    );
    if (error) {
      throw new Error(`Resend rejected the email: ${error.message}`);
    }
    return { providerMessageId: data.id };
  }
}

export function loadResendModule(
  load: () => Promise<typeof ResendModule> = () => import("resend"),
): Promise<typeof ResendModule> {
  return loadOptionalPeer("@dads-framework/email", "resend", load);
}

async function createResendClient(apiKey: string): Promise<Resend> {
  const { Resend } = await loadResendModule();
  return new Resend(apiKey);
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
