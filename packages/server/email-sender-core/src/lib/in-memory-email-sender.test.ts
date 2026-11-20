import { emailSenderConformance } from "./email-sender-conformance.js";
/**
 * The fake is what every other suite asserts against, so its capture, its
 * receipt, and its failure mode are pinned here rather than rediscovered per
 * consumer.
 */
import { describe, expect, it } from "vitest";
import { FakeEmailSender } from "./in-memory-email-sender.js";

describe("FakeEmailSender", () => {
  it("captures each message in send order", async () => {
    const sender = new FakeEmailSender();

    await sender.send({
      to: [{ address: "a@example.com" }],
      subject: "first",
      text: "1",
    });
    await sender.send({
      to: [{ address: "b@example.com" }],
      subject: "second",
      text: "2",
    });

    expect(sender.sent).toEqual([
      { to: [{ address: "a@example.com" }], subject: "first", text: "1" },
      { to: [{ address: "b@example.com" }], subject: "second", text: "2" },
    ]);
  });

  it("hands back a distinct receipt per send", async () => {
    const sender = new FakeEmailSender();

    const first = await sender.send({
      to: [{ address: "a@example.com" }],
      subject: "s",
      text: "t",
    });
    const second = await sender.send({
      to: [{ address: "a@example.com" }],
      subject: "s",
      text: "t",
    });

    expect([first, second]).toEqual([
      { providerMessageId: "fake-1" },
      { providerMessageId: "fake-2" },
    ]);
  });

  it("rejects and captures nothing once told to fail", async () => {
    const sender = new FakeEmailSender();
    sender.failEverySendWith(new Error("vendor unavailable"));

    await expect(
      sender.send({
        to: [{ address: "a@example.com" }],
        subject: "s",
        text: "t",
      }),
    ).rejects.toThrow("vendor unavailable");
    expect(sender.sent).toEqual([]);
  });
});

describe("EmailSender conformance against the in-memory fake", () => {
  it.each(emailSenderConformance)("$name", async ({ run }) => {
    await run((accepted) => {
      const sender = new FakeEmailSender();
      if (!accepted) sender.failEverySendWith(new Error("Refused"));
      return {
        sender,
        acceptedId: "fake-1",
        submittedEnvelope() {
          const message = sender.sent[0];
          if (message === undefined) return undefined;
          return {
            to: message.to.map((recipient) => recipient.address),
            subject: message.subject,
            text: message.text,
            html: message.html,
          };
        },
      };
    });
  });
});
