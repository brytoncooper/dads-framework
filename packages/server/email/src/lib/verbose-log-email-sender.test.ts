/**
 * VerboseLogEmailSender is the opposite trade from LogEmailSender: it prints
 * the whole email so a developer can read it in the API logs. These tests
 * pin that every field survives, because "read the email in the logs" is the
 * driver's only reason to exist — and that attachment BYTES are the one part
 * that still does not, because a base64 blob is not readable.
 */
import { describe, expect, it, vi } from "vitest";
import { VerboseLogEmailSender } from "./verbose-log-email-sender.js";

describe("VerboseLogEmailSender", () => {
  it("logs every field of a text email", async () => {
    const logInfo = vi.fn();

    await new VerboseLogEmailSender({ info: logInfo }, "Example App <dev@local>").send({
      to: [{ address: "alice@example.com" }],
      subject: "Your invitation",
      text: "Accept your invitation: http://localhost:4200/x#token=abc",
    });

    expect(logInfo).toHaveBeenCalledWith(
      {
        event: "email.rendered",
        from: "Example App <dev@local>",
        to: "alice@example.com",
        subject: "Your invitation",
        text: "Accept your invitation: http://localhost:4200/x#token=abc",
      },
      "email not sent (MAIL_DRIVER=log-verbose) — rendered above",
    );
  });

  it("includes the html body only when the message carries one", async () => {
    const logInfo = vi.fn();
    const sender = new VerboseLogEmailSender({ info: logInfo }, "d@local");

    await sender.send({
      to: [{ address: "a@b.c" }],
      subject: "s",
      text: "t",
    });
    await sender.send({
      to: [{ address: "a@b.c" }],
      subject: "s",
      text: "t",
      html: "<p>t</p>",
    });

    expect(logInfo.mock.calls[0]?.[0]).not.toHaveProperty("html");
    expect(logInfo.mock.calls[1]?.[0]).toMatchObject({ html: "<p>t</p>" });
  });

  it("renders every addressee, header and tag of a full envelope", async () => {
    const logInfo = vi.fn();

    await new VerboseLogEmailSender({ info: logInfo }, "d@local").send({
      to: [{ address: "alice@example.com", name: "Alice" }, { address: "bob@example.com" }],
      cc: [{ address: "cc@example.com" }],
      bcc: [{ address: "bcc@example.com" }],
      replyTo: { address: "reply@example.com" },
      from: { address: "ops@example.com", name: "Operations" },
      subject: "s",
      text: "t",
      headers: { "X-Example-Kind": "invitation" },
      tags: ["invitation", "test-send"],
    });

    expect(logInfo.mock.calls[0]?.[0]).toMatchObject({
      from: "Operations <ops@example.com>",
      to: "Alice <alice@example.com>, bob@example.com",
      cc: "cc@example.com",
      bcc: "bcc@example.com",
      replyTo: "reply@example.com",
      headers: { "X-Example-Kind": "invitation" },
      tags: ["invitation", "test-send"],
    });
  });

  it("names an attachment without ever logging its bytes", async () => {
    const logInfo = vi.fn();

    await new VerboseLogEmailSender({ info: logInfo }, "d@local").send({
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

    expect(logInfo.mock.calls[0]?.[0]).toMatchObject({
      attachments: [
        {
          filename: "packing-slip.pdf",
          contentType: "application/pdf",
          sizeBytes: 3,
        },
      ],
    });
    expect(JSON.stringify(logInfo.mock.calls)).not.toContain("104");
  });
});
