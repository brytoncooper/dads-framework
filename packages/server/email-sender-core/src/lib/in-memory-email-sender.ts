import {
  EmailSender,
  type EmailMessage,
  type EmailSendReceipt,
} from "./email-sender.js";

/**
 * Inspectable stand-in for tests: captures every message in `sent` so a test
 * can assert what the system would have emailed — subject, recipient, and the
 * link in the body — without a driver, a vendor, or a log spy.
 *
 * `failEverySendWith` covers the other half: the delivery-failure paths that
 * turn a vendor rejection into a typed domain error.
 */
export class FakeEmailSender extends EmailSender {
  /** Every message sent through this fake, in send order. */
  readonly sent: EmailMessage[] = [];
  private failure: Error | undefined;

  /** Every send from now on rejects — proves failure handling, not delivery. */
  failEverySendWith(error: Error): void {
    this.failure = error;
  }

  send(message: EmailMessage): Promise<EmailSendReceipt> {
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    this.sent.push(message);
    return Promise.resolve({ providerMessageId: `fake-${this.sent.length}` });
  }
}
