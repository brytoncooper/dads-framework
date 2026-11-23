import type { EmailMessage } from "../../core/index.js";
import { formatEmailAddress } from "./format-email-address.js";

/**
 * The message envelope in Mailgun's vocabulary. Mailgun's messages endpoint
 * takes multipart form fields rather than JSON, and expresses a list by
 * repeating the field name — one `to` per recipient, one `o:tag` per label —
 * so this builds a `FormData` rather than an object. Extra headers travel as
 * `h:<Header>`, which is also how reply-to is expressed.
 *
 * Pure: no network, no clock, no env. The driver adds only the host and the
 * credential.
 */
export function buildMailgunForm(
  message: EmailMessage,
  defaultFrom: string,
): FormData {
  const form = new FormData();

  form.append(
    "from",
    message.from === undefined ? defaultFrom : formatEmailAddress(message.from),
  );
  appendAddresses(form, "to", message.to);
  appendAddresses(form, "cc", message.cc);
  appendAddresses(form, "bcc", message.bcc);
  if (message.replyTo !== undefined) {
    form.append("h:Reply-To", formatEmailAddress(message.replyTo));
  }

  form.append("subject", message.subject);
  form.append("text", message.text);
  if (message.html !== undefined) form.append("html", message.html);

  appendAttachments(form, message.attachments);
  for (const tag of message.tags ?? []) form.append("o:tag", tag);
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    form.append(`h:${name}`, value);
  }

  return form;
}

function appendAddresses(
  form: FormData,
  field: string,
  addresses: EmailMessage["to"] | undefined,
): void {
  for (const address of addresses ?? []) {
    form.append(field, formatEmailAddress(address));
  }
}

function appendAttachments(
  form: FormData,
  attachments: EmailMessage["attachments"],
): void {
  for (const attachment of attachments ?? []) {
    // Copied into its own buffer because `File` accepts only ArrayBuffer-backed
    // bytes, and an `EmailAttachment` may be a view over a SharedArrayBuffer.
    // The copy is the honest way to say that; a cast would only hide it.
    const bytes = new Uint8Array(attachment.content);
    form.append(
      "attachment",
      new File([bytes], attachment.filename, { type: attachment.contentType }),
    );
  }
}
