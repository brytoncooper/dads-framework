import type {
  EmailMessage,
  EmailSender,
  EmailSendReceipt,
} from "../core/index.js";
import { buildMailgunForm } from "./logic/build-mailgun-form.js";

/**
 * Which Mailgun region the sending domain was created in. The two regions are
 * separate accounts behind separate hosts: a US key posted to the EU host is
 * rejected, so this is configuration, never a fallback to try.
 */
export type MailgunRegion = "us" | "eu";

export type MailgunEmailSenderOptions = {
  readonly apiKey: string;
  /** The sending domain Mailgun verified, e.g. `mail.example.com`. */
  readonly domain: string;
  readonly region: MailgunRegion;
  /** Sender address used when a message names no `from`. */
  readonly from: string;
};

const REGION_HOSTS: Readonly<Record<MailgunRegion, string>> = {
  us: "https://api.mailgun.net",
  eu: "https://api.eu.mailgun.net",
};

/** A vendor error page is evidence, not a log budget. */
const MAX_REJECTION_BODY_CHARACTERS = 500;

/**
 * The Mailgun driver — active when MAIL_DRIVER=mailgun. Mailgun's send is one
 * multipart POST, so this talks to it with `fetch` and no SDK; `fetchImpl` is
 * injected so the tests read the exact request rather than a vendor's mock.
 */
export class MailgunEmailSender implements EmailSender {
  constructor(
    private readonly options: MailgunEmailSenderOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: EmailMessage): Promise<EmailSendReceipt> {
    const response = await this.fetchImpl(this.messagesUrl(), {
      method: "POST",
      headers: { authorization: this.authorizationHeader() },
      body: buildMailgunForm(message, this.options.from),
    });
    if (!response.ok) {
      throw new Error(await describeRejection(response));
    }
    return { providerMessageId: await readMessageId(response) };
  }

  private messagesUrl(): string {
    return `${REGION_HOSTS[this.options.region]}/v3/${this.options.domain}/messages`;
  }

  private authorizationHeader(): string {
    return `Basic ${Buffer.from(`api:${this.options.apiKey}`).toString("base64")}`;
  }
}

/**
 * What went wrong, in the terms an operator can act on: the status and what
 * Mailgun said. Never the API key and never a recipient — this string reaches
 * the logs and the `last_error` column.
 */
async function describeRejection(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  const detail = body.slice(0, MAX_REJECTION_BODY_CHARACTERS);
  return `Mailgun rejected the email (${response.status}): ${detail}`;
}

/**
 * Mailgun answers an accepted message with `{ id, message }`, but a proxy or
 * a future response shape can answer with anything. A missing id is a receipt
 * without a handle, not a failed send, so this reads leniently.
 */
async function readMessageId(response: Response): Promise<string | null> {
  const payload: unknown = await response.json().catch(() => undefined);
  if (typeof payload !== "object" || payload === null) return null;
  const id: unknown = Reflect.get(payload, "id");
  return typeof id === "string" && id.length > 0 ? id : null;
}
