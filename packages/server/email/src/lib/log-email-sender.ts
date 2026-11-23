import type { EmailMessage, EmailSender, EmailSendReceipt } from "../core/index.js";
import { describeEmailMessage } from "./logic/describe-email-message.js";

/**
 * Development/test driver: structured-logs that a send was attempted and
 * drops the body so addresses and tokens never appear in logs.
 */
export class LogEmailSender implements EmailSender {
  constructor(private readonly log: { info(obj: object, msg?: string): void }) {}

  send(message: EmailMessage): Promise<EmailSendReceipt> {
    this.log.info({
      event: "email.logged",
      ...describeEmailMessage(message),
    });
    return Promise.resolve({ providerMessageId: null });
  }
}
