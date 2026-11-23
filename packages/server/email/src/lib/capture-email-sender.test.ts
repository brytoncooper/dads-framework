/**
 * The capture driver exists so a developer can READ the email — body, link and
 * all — on the development mail page. These tests pin what that page depends
 * on: the whole message survives the send, addresses arrive already rendered,
 * attachments arrive named but never as bytes, the newest capture sits first,
 * Clear empties the mailbox, and a long session drops the oldest capture
 * instead of growing without bound.
 */
import { describe, expect, it } from "vitest";
import { CaptureEmailSender } from "./capture-email-sender.js";
import { CapturedMailbox } from "./captured-mailbox.js";

const invitation = {
  to: [{ address: "alice@example.com" }],
  subject: "Your invitation",
  text: "Accept your invitation: http://app.example.test/accept#token=abc",
  html: "<p>Accept your invitation</p>",
};

const fixedClock = () => new Date("2026-08-21T17:04:05.000Z");

describe("CaptureEmailSender", () => {
  it("captures the whole message so the page can render it", async () => {
    const mailbox = new CapturedMailbox({ now: fixedClock });

    const receipt = await new CaptureEmailSender(mailbox, "Example App <dev@local>").send(invitation);

    expect(receipt).toEqual({ providerMessageId: "mail-1" });
    expect(mailbox.list()).toEqual([
      {
        id: "mail-1",
        capturedAt: "2026-08-21T17:04:05.000Z",
        from: "Example App <dev@local>",
        to: "alice@example.com",
        subject: "Your invitation",
        text: "Accept your invitation: http://app.example.test/accept#token=abc",
        html: "<p>Accept your invitation</p>",
      },
    ]);
  });

  it("renders every addressee into the header the page shows", async () => {
    const mailbox = new CapturedMailbox({ now: fixedClock });

    await new CaptureEmailSender(mailbox, "Example App <dev@local>").send({
      to: [{ address: "alice@example.com", name: "Alice" }, { address: "bob@example.com" }],
      cc: [{ address: "cc@example.com" }],
      bcc: [{ address: "bcc@example.com" }],
      replyTo: { address: "reply@example.com" },
      from: { address: "ops@example.com", name: "Operations" },
      subject: "s",
      text: "t",
      tags: ["invitation"],
      headers: { "X-Example-Kind": "invitation" },
    });

    expect(mailbox.list()[0]).toMatchObject({
      from: "Operations <ops@example.com>",
      to: "Alice <alice@example.com>, bob@example.com",
      cc: "cc@example.com",
      bcc: "bcc@example.com",
      replyTo: "reply@example.com",
      tags: ["invitation"],
      headers: { "X-Example-Kind": "invitation" },
    });
  });

  it("keeps an attachment's name and size and drops its bytes", async () => {
    const mailbox = new CapturedMailbox({ now: fixedClock });

    await new CaptureEmailSender(mailbox, "Example App <dev@local>").send({
      to: [{ address: "a@b.c" }],
      subject: "s",
      text: "t",
      attachments: [
        {
          filename: "packing-slip.pdf",
          contentType: "application/pdf",
          content: Uint8Array.from([104, 105, 106]),
        },
      ],
    });

    expect(mailbox.list()[0]?.attachments).toEqual([
      {
        filename: "packing-slip.pdf",
        contentType: "application/pdf",
        sizeBytes: 3,
      },
    ]);
    expect(JSON.stringify(mailbox.list())).not.toContain("104");
  });

  it("captures a text-only message without an html body", async () => {
    const mailbox = new CapturedMailbox({ now: fixedClock });

    await new CaptureEmailSender(mailbox, "Example App <dev@local>").send({
      to: [{ address: "alice@example.com" }],
      subject: "Verify your email",
      text: "Verify: http://app.example.test/verify#token=abc",
    });

    expect(mailbox.list()[0]).not.toHaveProperty("html");
    expect(mailbox.list()[0]).not.toHaveProperty("cc");
    expect(mailbox.list()[0]).not.toHaveProperty("attachments");
  });

  it("lists the newest capture first", async () => {
    const mailbox = new CapturedMailbox({ now: fixedClock });
    const sender = new CaptureEmailSender(mailbox, "Example App <dev@local>");

    await sender.send({
      to: [{ address: "a@b.c" }],
      subject: "first",
      text: "t",
    });
    await sender.send({
      to: [{ address: "a@b.c" }],
      subject: "second",
      text: "t",
    });

    expect(mailbox.list().map((email) => email.subject)).toEqual(["second", "first"]);
    expect(mailbox.list().map((email) => email.id)).toEqual(["mail-2", "mail-1"]);
  });

  it("drops the oldest capture once the mailbox is full", async () => {
    const mailbox = new CapturedMailbox({ capacity: 2, now: fixedClock });
    const sender = new CaptureEmailSender(mailbox, "Example App <dev@local>");

    await sender.send({
      to: [{ address: "a@b.c" }],
      subject: "first",
      text: "t",
    });
    await sender.send({
      to: [{ address: "a@b.c" }],
      subject: "second",
      text: "t",
    });
    await sender.send({
      to: [{ address: "a@b.c" }],
      subject: "third",
      text: "t",
    });

    expect(mailbox.list().map((email) => email.subject)).toEqual(["third", "second"]);
  });

  it("empties on clear and never reuses an id it already handed out", async () => {
    const mailbox = new CapturedMailbox({ now: fixedClock });
    const sender = new CaptureEmailSender(mailbox, "Example App <dev@local>");
    await sender.send(invitation);

    mailbox.clear();
    expect(mailbox.list()).toEqual([]);

    await sender.send(invitation);
    expect(mailbox.list().map((email) => email.id)).toEqual(["mail-2"]);
  });
});
