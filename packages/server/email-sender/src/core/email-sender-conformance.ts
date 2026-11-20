import { deepEqual, equal, rejects } from "node:assert/strict";

import type { EmailMessage, EmailSender } from "./email-sender.js";

type EmailSenderFixture = {
  readonly sender: EmailSender;
  readonly acceptedId: string;
  readonly submittedEnvelope: () => unknown;
};

type EmailSenderConformanceCase = {
  readonly name: string;
  readonly run: (
    open: (accepted: boolean) => EmailSenderFixture,
  ) => Promise<void>;
};

const MESSAGE: EmailMessage = {
  to: [{ address: "recipient@example.test" }],
  subject: "Conformance",
  text: "Plain body",
  html: "<p>HTML body</p>",
};

export const emailSenderConformance: readonly EmailSenderConformanceCase[] = [
  {
    name: "submits the recipient and both body formats and returns the receipt",
    async run(open) {
      const fixture = open(true);

      const receipt = await fixture.sender.send(MESSAGE);

      equal(receipt.providerMessageId, fixture.acceptedId);
      deepEqual(fixture.submittedEnvelope(), {
        to: ["recipient@example.test"],
        subject: MESSAGE.subject,
        text: MESSAGE.text,
        html: MESSAGE.html,
      });
    },
  },
  {
    name: "reports a refused send as a rejection",
    async run(open) {
      const fixture = open(false);
      await rejects(() => fixture.sender.send(MESSAGE), Error);
    },
  },
];
