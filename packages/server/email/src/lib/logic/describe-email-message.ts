import type { EmailMessage } from "../../core/index.js";

/**
 * The shape of a message that is safe to write anywhere — counts and flags,
 * never an address, a subject, a body, a header value, a tag, or a byte.
 */
export type EmailMessageDescription = {
  readonly recipientCount: number;
  readonly ccCount: number;
  readonly bccCount: number;
  readonly attachmentCount: number;
  readonly tagCount: number;
  readonly headerCount: number;
  readonly hasHtml: boolean;
  readonly hasReplyTo: boolean;
};

/**
 * Describe a message for a log line. Bodies carry one-time invitation and
 * verification tokens and recipients are personal data, so the default driver
 * records only that a send happened and how big it was.
 */
export function describeEmailMessage(message: EmailMessage): EmailMessageDescription {
  return {
    recipientCount: message.to.length,
    ccCount: message.cc?.length ?? 0,
    bccCount: message.bcc?.length ?? 0,
    attachmentCount: message.attachments?.length ?? 0,
    tagCount: message.tags?.length ?? 0,
    headerCount: Object.keys(message.headers ?? {}).length,
    hasHtml: message.html !== undefined,
    hasReplyTo: message.replyTo !== undefined,
  };
}
