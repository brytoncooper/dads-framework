/**
 * LogEmailSender records that a send was attempted without writing the
 * address or body — so local/CI logs cannot leak invitation tokens.
 */
import { describe, expect, it, vi } from "vitest";
import { LogEmailSender } from "./log-email-sender.js";

describe("LogEmailSender", () => {
  it("reports no vendor id and logs only the envelope's shape", async () => {
    const logInfo = vi.fn();
    await expect(
      new LogEmailSender({ info: logInfo }).send({
        to: [{ address: "alice@example.com", name: "Alice" }],
        subject: "hi",
        text: "secret invitation token",
      }),
    ).resolves.toEqual({ providerMessageId: null });
    expect(logInfo).toHaveBeenCalledWith({
      event: "email.logged",
      recipientCount: 1,
      ccCount: 0,
      bccCount: 0,
      attachmentCount: 0,
      tagCount: 0,
      headerCount: 0,
      hasHtml: false,
      hasReplyTo: false,
    });
    expect(JSON.stringify(logInfo.mock.calls)).not.toContain("alice@example.com");
    expect(JSON.stringify(logInfo.mock.calls)).not.toContain("secret");
  });

  it("withholds every part of a full envelope too", async () => {
    const logInfo = vi.fn();

    await new LogEmailSender({ info: logInfo }).send({
      to: [{ address: "alice@example.com" }],
      cc: [{ address: "cc@example.com" }],
      bcc: [{ address: "bcc@example.com" }],
      replyTo: { address: "reply@example.com" },
      subject: "hi",
      text: "secret invitation token",
      html: "<p>secret invitation token</p>",
      attachments: [
        {
          filename: "packing-slip.pdf",
          contentType: "application/pdf",
          content: Uint8Array.from([1, 2, 3]),
        },
      ],
      headers: { "X-Example-Kind": "invitation" },
      tags: ["invitation"],
    });

    expect(logInfo).toHaveBeenCalledWith({
      event: "email.logged",
      recipientCount: 1,
      ccCount: 1,
      bccCount: 1,
      attachmentCount: 1,
      tagCount: 1,
      headerCount: 1,
      hasHtml: true,
      hasReplyTo: true,
    });
    const logged = JSON.stringify(logInfo.mock.calls);
    for (const secret of [
      "alice@example.com",
      "cc@example.com",
      "bcc@example.com",
      "reply@example.com",
      "secret",
      "packing-slip.pdf",
      "invitation",
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});
