import type {
  EmailAddress,
  EmailAttachment,
  EmailMessage,
} from "@dads-framework/email-sender-core";

import type { EmailEnvelope } from "../email-envelope.js";
import type { RenderedEmailContent } from "../email-template-port.js";

/**
 * The envelope and the rendered halves, as the one message a driver sends.
 *
 * Both delivery paths end here — the immediate `sendNow` and the queued
 * delivery job — so "what an email looks like on the wire" is decided
 * once. Optional fields are spread conditionally because an explicit
 * `undefined` is not the same as an absent key under
 * `exactOptionalPropertyTypes`.
 */
export function toEmailMessage(
  envelope: EmailEnvelope,
  rendered: RenderedEmailContent,
  attachments: readonly EmailAttachment[] = [],
): EmailMessage {
  return {
    to: envelope.to.map(toEmailAddress),
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    ...(envelope.cc === undefined
      ? {}
      : { cc: envelope.cc.map(toEmailAddress) }),
    ...(envelope.bcc === undefined
      ? {}
      : { bcc: envelope.bcc.map(toEmailAddress) }),
    ...(envelope.replyTo === undefined
      ? {}
      : { replyTo: toEmailAddress(envelope.replyTo) }),
    ...(envelope.headers === undefined ? {} : { headers: envelope.headers }),
    ...(envelope.tags === undefined ? {} : { tags: envelope.tags }),
    ...(attachments.length === 0 ? {} : { attachments }),
  };
}

/** A parsed address as the driver takes it: a missing name stays missing. */
function toEmailAddress(address: {
  readonly address: string;
  readonly name?: string | undefined;
}): EmailAddress {
  return address.name === undefined
    ? { address: address.address }
    : { address: address.address, name: address.name };
}
