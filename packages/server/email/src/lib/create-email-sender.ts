import { CaptureEmailSender } from "./capture-email-sender.js";
import type { CapturedMailbox } from "./captured-mailbox.js";
import type { EmailSender } from "../core/index.js";
import { LogEmailSender } from "./log-email-sender.js";
import { MailgunEmailSender, type MailgunRegion } from "./mailgun-email-sender.js";
import { ResendEmailSender } from "./resend-email-sender.js";
import { VerboseLogEmailSender } from "./verbose-log-email-sender.js";

/**
 * Every driver MAIL_DRIVER may name. Adding a vendor adds a member here and
 * a branch below — see the README's "Adding a driver".
 */
export type EmailSenderDriver = "log" | "log-verbose" | "capture" | "resend" | "mailgun";

export type CreateEmailSenderOptions = {
  /**
   * "log" (default — records that a send happened, withholds the body),
   * "log-verbose" (a developer's own machine only — renders the whole email
   * into the logs, tokens included), "capture" (a developer's own machine
   * only — keeps whole messages in memory for the development mail page), or
   * "resend" (really sends).
   */
  readonly driver: EmailSenderDriver;
  /** required when driver is "resend" */
  readonly apiKey?: string;
  /** required when driver is "capture" — the store the mail page reads */
  readonly mailbox?: CapturedMailbox;
  /** required when driver is "mailgun" */
  readonly mailgunApiKey?: string;
  /** required when driver is "mailgun" — the verified sending domain */
  readonly mailgunDomain?: string;
  /** Which Mailgun account region the sending domain belongs to. */
  readonly mailgunRegion?: MailgunRegion;
  /** Sender address used as the From header. */
  readonly from: string;
};

type EmailSenderLog = {
  info(obj: object, msg?: string): void;
};

/** Picks the driver MAIL_DRIVER names; the caller only ever holds EmailSender. */
export function createEmailSender(options: CreateEmailSenderOptions, log: EmailSenderLog): EmailSender {
  if (options.driver === "resend") {
    if (!options.apiKey) {
      throw new Error("MAIL_DRIVER=resend requires RESEND_API_KEY");
    }
    return new ResendEmailSender(options.apiKey, options.from);
  }
  if (options.driver === "mailgun") {
    if (!options.mailgunApiKey || !options.mailgunDomain) {
      throw new Error("MAIL_DRIVER=mailgun requires MAILGUN_API_KEY and MAILGUN_DOMAIN");
    }
    return new MailgunEmailSender({
      apiKey: options.mailgunApiKey,
      domain: options.mailgunDomain,
      region: options.mailgunRegion ?? "us",
      from: options.from,
    });
  }
  if (options.driver === "log-verbose") {
    return new VerboseLogEmailSender(log, options.from);
  }
  if (options.driver === "capture") {
    if (!options.mailbox) {
      throw new Error("MAIL_DRIVER=capture requires a captured mailbox (development only)");
    }
    return new CaptureEmailSender(options.mailbox, options.from);
  }
  return new LogEmailSender(log);
}
